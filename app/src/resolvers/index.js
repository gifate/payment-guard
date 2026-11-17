/**
 * Backend resolvers called from the UI Kit front ends with `invoke(...)`.
 * Every function reads the work item key from the Forge context (never from
 * the client payload) so a user cannot act on a work item they are not viewing.
 */
import Resolver from '@forge/resolver';
import * as store from '../lib/store.js';
import { checkAndRecord, recheckVendor, verifyVendorAccount, evaluateIssue, recordBankChange } from '../lib/guard.js';
import { addComment, setHoldLabel, userCanEdit, userIsAdmin, filterVisible } from '../lib/jira.js';
import { maskAccount, normalizeVendor } from '../lib/normalize.js';

const resolver = new Resolver();

const issueKeyOf = (req) => req.context?.extension?.issue?.key;
const MIN_REASON_LENGTH = 10;
const EDIT_REQUIRED = { error: 'You need permission to edit this work item to change Payment Guard data.' };

/**
 * Every change made from the panel needs edit rights on the work item:
 * otherwise someone who can only view it could retype the invoice data so that
 * the checks pass and the hold is lifted.
 */
const canEdit = (issueKey) => userCanEdit(issueKey);

/** Describes which invoice fields changed, masking bank accounts. */
function describeChanges(previous, next) {
  if (!previous) return [];
  const fields = ['vendor', 'invoiceNo', 'amount', 'currency', 'invoiceDate', 'bankAccount'];
  return fields
    .filter((field) => String(previous[field] ?? '') !== String(next[field] ?? ''))
    .map((field) =>
      field === 'bankAccount'
        ? `bankAccount: ${maskAccount(previous[field]) || '(empty)'} → ${maskAccount(next[field]) || '(empty)'}`
        : `${field}: "${previous[field] ?? ''}" → "${next[field] ?? ''}"`
    );
}

/** Trims every string field and limits its length. */
function clean(input, fields) {
  const out = {};
  for (const field of fields) out[field] = String(input?.[field] ?? '').trim().slice(0, 200);
  return out;
}

/** Everything the issue panel needs in one call. */
resolver.define('getState', async (req) => {
  const issueKey = issueKeyOf(req);
  const [invoice, bankChange, hold, audit, settings] = await Promise.all([
    store.getInvoice(issueKey),
    store.getBankChange(issueKey),
    store.getHold(issueKey),
    store.listAudit(issueKey),
    store.getSettings(),
  ]);
  let verifiedBank = null;
  if (invoice) {
    const bank = await store.getVerifiedBank(normalizeVendor(invoice.vendor));
    if (bank) verifiedBank = { account: maskAccount(bank.account), verifiedAt: bank.verifiedAt, verifiedBy: bank.verifiedBy };
  }
  return {
    issueKey,
    invoice: invoice ? { ...invoice, bankAccountMasked: maskAccount(invoice.bankAccount) } : null,
    bankChange: bankChange ? { ...bankChange, newAccountMasked: maskAccount(bankChange.newAccount) } : null,
    hold,
    verifiedBank,
    audit,
    settings,
  };
});

/** Records (or updates) invoice data on this work item and checks it. */
resolver.define('saveInvoice', async (req) => {
  const issueKey = issueKeyOf(req);
  const accountId = req.context.accountId;
  if (!(await canEdit(issueKey))) return EDIT_REQUIRED;
  const invoice = clean(req.payload, ['vendor', 'invoiceNo', 'amount', 'currency', 'invoiceDate', 'bankAccount']);
  const previous = await store.getInvoice(issueKey);
  const changes = describeChanges(previous, invoice);
  if (previous && changes.length === 0) {
    return { hold: await checkAndRecord(issueKey, accountId, 'manual re-check') };
  }
  // recordedAt is kept from the first save: it decides which invoice is the
  // original and which one is the later duplicate.
  await store.setInvoice(issueKey, {
    ...invoice,
    recordedBy: previous?.recordedBy ?? accountId,
    recordedAt: previous?.recordedAt ?? Date.now(),
    updatedBy: accountId,
    updatedAt: Date.now(),
    source: previous?.source === 'auto' ? 'auto, corrected by a person' : previous?.source || 'panel',
  });
  await store.addAudit(issueKey, {
    type: previous ? 'invoice-updated' : 'invoice-recorded',
    by: accountId,
    reason: changes.join('; ') || undefined,
  });
  // The trigger text ends up in the comment when a hold is lifted, so the
  // audit trail shows exactly which edit made the checks pass.
  const trigger = previous ? `invoice data changed (${changes.join('; ')})` : 'invoice recorded';
  const hold = await checkAndRecord(issueKey, accountId, trigger);
  return { hold };
});

/** Re-runs the checks (e.g. after the waiting period is over). */
resolver.define('recheck', async (req) => {
  const issueKey = issueKeyOf(req);
  if (!(await canEdit(issueKey))) return EDIT_REQUIRED;
  return { hold: await checkAndRecord(issueKey, req.context.accountId, 'manual re-check') };
});

/** Releases the hold. Requires edit rights on the work item and a written reason. */
resolver.define('releaseHold', async (req) => {
  const issueKey = issueKeyOf(req);
  const accountId = req.context.accountId;
  const reason = String(req.payload?.reason ?? '').trim().slice(0, 1000);
  if (reason.length < MIN_REASON_LENGTH) {
    return { error: `Please write a reason of at least ${MIN_REASON_LENGTH} characters.` };
  }
  const hold = await store.getHold(issueKey);
  if (!hold || hold.status !== 'held') return { error: 'This work item is not on hold.' };
  if (!(await userCanEdit(issueKey))) {
    return { error: 'You need permission to edit this work item to release its hold.' };
  }
  // Mirror into Jira first, as the user. If Jira refuses, nothing is released.
  const label = await setHoldLabel(issueKey, false);
  if (!label.ok) return { error: `Jira refused the change (HTTP ${label.status}). The hold stays.` };
  const record = { ...hold, status: 'released', releasedBy: accountId, releasedAt: Date.now(), releaseReason: reason };
  await store.setHold(issueKey, record);
  await addComment(issueKey, [
    'Payment Guard: hold RELEASED by a person.',
    `Reason: ${reason}`,
    `Released reasons: ${hold.reasons.map((r) => r.code).join(', ')}`,
  ]);
  await store.addAudit(issueKey, { type: 'release', by: accountId, reason, codes: hold.reasons.map((r) => r.code) });
  return { hold: record };
});

/** First payment to a vendor: confirm its bank account by call-back. */
resolver.define('verifyInvoiceBank', async (req) => {
  const issueKey = issueKeyOf(req);
  const accountId = req.context.accountId;
  const note = String(req.payload?.note ?? '').trim().slice(0, 1000);
  if (note.length < MIN_REASON_LENGTH) {
    return { error: `Describe the call-back (who you called, on which number) in at least ${MIN_REASON_LENGTH} characters.` };
  }
  if (!(await canEdit(issueKey))) return EDIT_REQUIRED;
  const invoice = await store.getInvoice(issueKey);
  if (!invoice) return { error: 'Record the invoice first.' };
  const existing = await store.getVerifiedBank(normalizeVendor(invoice.vendor));
  if (existing) {
    return { error: 'This vendor already has a verified account. A different account must go through a bank-change request.' };
  }
  await verifyVendorAccount({ vendor: invoice.vendor, account: invoice.bankAccount, accountId, note, sourceIssueKey: issueKey });
  await addComment(issueKey, [`Payment Guard: bank account ${maskAccount(invoice.bankAccount)} verified by call-back.`, `Note: ${note}`], {
    allowAppFallback: true,
  });
  const affected = await recheckVendor(invoice.vendor, accountId, 'vendor bank verified');
  return { affected };
});

/** Records a vendor bank-account change request on this work item. */
resolver.define('saveBankChange', async (req) => {
  const issueKey = issueKeyOf(req);
  const accountId = req.context.accountId;
  const change = clean(req.payload, ['vendor', 'newAccount']);
  if (!change.vendor || !change.newAccount) return { error: 'Vendor and new bank account are required.' };
  if (!(await canEdit(issueKey))) return EDIT_REQUIRED;
  const affected = await recordBankChange(issueKey, change, accountId, 'bank change requested');
  return { affected };
});

/** Confirms a bank-account change after a call-back; starts the waiting period. */
resolver.define('verifyBankChange', async (req) => {
  const issueKey = issueKeyOf(req);
  const accountId = req.context.accountId;
  const note = String(req.payload?.note ?? '').trim().slice(0, 1000);
  if (note.length < MIN_REASON_LENGTH) {
    return { error: `Describe the call-back (who you called, on which number) in at least ${MIN_REASON_LENGTH} characters.` };
  }
  const change = await store.getBankChange(issueKey);
  if (!change) return { error: 'No bank-change request on this work item.' };
  if (change.verifiedAt) return { error: 'This change is already verified.' };
  if (!(await userCanEdit(issueKey))) return { error: 'You need permission to edit this work item to verify the change.' };
  const settings = await store.getSettings();
  if (settings.requireSecondPerson && change.requestedBy === accountId) {
    // Segregation of duties: the person who entered the change cannot approve it.
    return { error: 'The person who recorded the change cannot also verify it. Ask a colleague.' };
  }
  const now = Date.now();
  await store.setBankChange(issueKey, { ...change, verifiedAt: now, verifiedBy: accountId, note });
  await verifyVendorAccount({ vendor: change.vendor, account: change.newAccount, accountId, note, sourceIssueKey: issueKey });
  await setHoldLabel(issueKey, false, { allowAppFallback: true });
  const { coolingDays } = settings;
  await addComment(issueKey, [
    `Payment Guard: bank-account change verified by call-back. Note: ${note}`,
    `Payments to the new account stay on hold for ${coolingDays} more day(s) (waiting period), then pass on re-check.`,
  ]);
  const affected = await recheckVendor(change.vendor, accountId, 'bank change verified');
  return { affected };
});

/** Preview of the decision without saving (used by the panel before saving). */
resolver.define('preview', async (req) => {
  const issueKey = issueKeyOf(req);
  const invoice = clean(req.payload, ['vendor', 'invoiceNo', 'amount', 'currency', 'invoiceDate', 'bankAccount']);
  return evaluateIssue(issueKey, invoice);
});

/** Data for the global "Payment Guard" page. */
resolver.define('listHolds', async () => {
  const [allHolds, allChanges, settings] = await Promise.all([store.listHolds(), store.listBankChanges(), store.getSettings()]);
  // Only show work items the viewer is allowed to see.
  const visible = new Set(await filterVisible([...allHolds.map((h) => h.issueKey), ...allChanges.map((c) => c.issueKey)]));
  const holds = allHolds.filter((hold) => visible.has(hold.issueKey));
  const changes = allChanges.filter((change) => visible.has(change.issueKey));
  // A release stays listed even if the item was later re-held for a new reason.
  const released = [
    ...holds
      .filter((hold) => hold.status === 'released')
      .map((hold) => ({
        issueKey: hold.issueKey,
        releasedBy: hold.releasedBy,
        releasedAt: hold.releasedAt,
        releaseReason: hold.releaseReason,
        codes: hold.reasons.map((reason) => reason.code),
        nowStatus: 'released',
      })),
    ...holds
      .filter((hold) => hold.status !== 'released' && hold.lastRelease)
      .map((hold) => ({ issueKey: hold.issueKey, ...hold.lastRelease, nowStatus: hold.status })),
  ];
  return {
    holds: holds.filter((hold) => hold.status === 'held').sort((a, b) => (a.heldAt || 0) - (b.heldAt || 0)),
    released: released.sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0)),
    pendingChanges: changes.filter((change) => !change.verifiedAt).map((change) => ({ ...change, newAccount: maskAccount(change.newAccount) })),
    settings,
  };
});

resolver.define('saveSettings', async (req) => {
  if (!(await userIsAdmin())) return { error: 'Only Jira administrators can change Payment Guard settings.' };
  const days = Math.round(Number(req.payload?.coolingDays));
  if (!Number.isFinite(days) || days < 0 || days > 30) return { error: 'Waiting period must be between 0 and 30 days.' };
  const settings = { coolingDays: days, requireSecondPerson: Boolean(req.payload?.requireSecondPerson) };
  await store.setSettings(settings);
  await store.addAudit('settings', { type: 'settings', by: req.context.accountId, ...settings });
  return { settings };
});

export const handler = resolver.getDefinitions();

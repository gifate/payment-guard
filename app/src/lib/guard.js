/**
 * Guard service: loads what Payment Guard knows, runs the rules, and records
 * the decision (KVS + Jira label + Jira comment + audit trail).
 */
import { evaluateInvoice } from './rules.js';
import { normalizeVendor, normalizeAccount, maskAccount } from './normalize.js';
import * as store from './store.js';
import { addComment, setHoldLabel } from './jira.js';

/** A stable fingerprint of the reasons, used to avoid re-holding after a release. */
const fingerprint = (reasons) =>
  reasons
    .map((reason) => `${reason.code}:${[...reason.relatedKeys].sort().join(',')}`)
    .sort()
    .join('|');

/** The part of a hold record that describes a human release. */
const releaseOf = (hold) => ({
  releasedBy: hold.releasedBy,
  releasedAt: hold.releasedAt,
  releaseReason: hold.releaseReason,
  codes: hold.reasons.map((reason) => reason.code),
});

/** Runs the rules for one invoice without saving anything. */
export async function evaluateIssue(issueKey, invoice) {
  const vendorKey = normalizeVendor(invoice.vendor);
  const [allInvoices, allChanges, verifiedBank, settings] = await Promise.all([
    store.listInvoices(),
    store.listBankChanges(),
    vendorKey ? store.getVerifiedBank(vendorKey) : null,
    store.getSettings(),
  ]);
  return evaluateInvoice({
    issueKey,
    invoice,
    otherInvoices: allInvoices.map(({ issueKey: key, ...rest }) => ({ issueKey: key, invoice: rest })),
    verifiedBank: verifiedBank || null,
    bankChanges: allChanges.filter((change) => normalizeVendor(change.vendor) === vendorKey),
    coolingDays: settings.coolingDays,
  });
}

/**
 * Re-checks one invoice and records the outcome.
 * @returns the saved hold record.
 */
export async function checkAndRecord(issueKey, accountId, trigger) {
  const invoice = await store.getInvoice(issueKey);
  if (!invoice) return null;
  const result = await evaluateIssue(issueKey, invoice);
  const previous = await store.getHold(issueKey);
  const now = Date.now();
  const print = fingerprint(result.reasons);

  if (result.status === 'CLEAR') {
    const record = {
      status: 'clear',
      reasons: [],
      checkedAt: now,
      vendor: invoice.vendor,
      lastRelease: previous?.status === 'released' ? releaseOf(previous) : previous?.lastRelease,
    };
    await store.setHold(issueKey, record);
    if (previous && previous.status === 'held') {
      // The data now passes every rule (e.g. waiting period over): lift the hold.
      await setHoldLabel(issueKey, false, { allowAppFallback: true });
      await addComment(
        issueKey,
        [
          'Payment Guard: CLEAR — all checks now pass. Hold lifted automatically.',
          `What changed: ${trigger}.`,
          `Previously held for: ${previous.reasons.map((reason) => reason.code).join(', ')}.`,
        ],
        { allowAppFallback: true }
      );
      await store.addAudit(issueKey, {
        type: 'auto-lift',
        by: accountId,
        reason: trigger,
        codes: previous.reasons.map((reason) => reason.code),
      });
    }
    await store.addAudit(issueKey, { type: 'check', status: 'CLEAR', by: accountId, trigger });
    return record;
  }

  // HOLD. If a person already released exactly these reasons, respect that.
  if (previous && previous.status === 'released' && previous.fingerprint === print) {
    const record = { ...previous, checkedAt: now };
    await store.setHold(issueKey, record);
    await store.addAudit(issueKey, { type: 'check', status: 'RELEASED (unchanged reasons)', by: accountId, trigger });
    return record;
  }

  const record = {
    status: 'held',
    reasons: result.reasons,
    fingerprint: print,
    heldAt: previous?.status === 'held' ? previous.heldAt : now,
    checkedAt: now,
    vendor: invoice.vendor,
    // Keep the last release visible even when a new reason puts the item back on hold.
    lastRelease: previous?.status === 'released' ? releaseOf(previous) : previous?.lastRelease,
  };
  await store.setHold(issueKey, record);
  const isNewOrChanged = !previous || previous.status !== 'held' || previous.fingerprint !== print;
  if (isNewOrChanged) {
    await setHoldLabel(issueKey, true, { allowAppFallback: true });
    await addComment(
      issueKey,
      [
        'Payment Guard: HOLD — do not pay this invoice yet.',
        ...result.reasons.map(
          (reason) =>
            `• [${reason.code}] ${reason.message}${reason.relatedKeys.length ? ` See ${reason.relatedKeys.join(', ')}.` : ''}`
        ),
        'To pay anyway, release the hold in the Payment Guard panel with a written reason.',
      ],
      { allowAppFallback: true }
    );
  }
  await store.addAudit(issueKey, {
    type: 'check',
    status: 'HOLD',
    codes: result.reasons.map((reason) => reason.code),
    by: accountId,
    trigger,
  });
  return record;
}

/** Re-checks every recorded invoice of a vendor (after a bank change event). */
export async function recheckVendor(vendor, accountId, trigger) {
  const vendorKey = normalizeVendor(vendor);
  const invoices = await store.listInvoices();
  const affected = invoices.filter((invoice) => normalizeVendor(invoice.vendor) === vendorKey);
  for (const invoice of affected) {
    await checkAndRecord(invoice.issueKey, accountId, trigger);
  }
  return affected.map((invoice) => invoice.issueKey);
}

/**
 * Records a vendor bank-account change request on a work item and holds every
 * payment to that vendor. Used by the panel and by the "work item created" trigger.
 */
export async function recordBankChange(issueKey, change, accountId, trigger) {
  await store.setBankChange(issueKey, {
    vendor: change.vendor,
    newAccount: change.newAccount,
    requestedBy: accountId,
    requestedAt: Date.now(),
    verifiedAt: null,
    source: trigger,
  });
  await store.addAudit(issueKey, {
    type: 'bank-change-requested',
    vendor: change.vendor,
    account: maskAccount(change.newAccount),
    by: accountId,
    trigger,
  });
  await setHoldLabel(issueKey, true, { allowAppFallback: true });
  await addComment(
    issueKey,
    [
      `Payment Guard: bank-account change requested for "${change.vendor}" (new account ${maskAccount(change.newAccount)}).`,
      'Every payment to this vendor is ON HOLD until the change is verified by calling the vendor on a number already on file (not one from this request).',
    ],
    { allowAppFallback: true }
  );
  return recheckVendor(change.vendor, accountId, trigger);
}

/** Records the vendor's bank account as verified by call-back. */
export async function verifyVendorAccount({ vendor, account, accountId, note, sourceIssueKey }) {
  const vendorKey = normalizeVendor(vendor);
  await store.setVerifiedBank(vendorKey, {
    vendor,
    account: normalizeAccount(account),
    verifiedAt: Date.now(),
    verifiedBy: accountId,
    note,
    sourceIssueKey,
  });
  await store.addAudit(sourceIssueKey, {
    type: 'verify-bank',
    vendor,
    account: maskAccount(account),
    by: accountId,
    note,
  });
}

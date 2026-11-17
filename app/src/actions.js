/**
 * Rovo / MCP actions. These are the same guard rules as the work item panel,
 * exposed as READ-ONLY tools:
 *   - check-invoice : "would this invoice be held?" (nothing is saved)
 *   - list-holds    : what is on hold right now
 *   - explain-hold  : why one work item is on hold
 *
 * Releasing a hold is deliberately NOT a tool: a person must do that in the
 * panel with a written reason, so an AI agent can never un-block a payment.
 *
 * Every result only mentions work items the calling user is allowed to see
 * (checked with the user's own Jira permissions).
 */
import * as store from './lib/store.js';
import { evaluateIssue } from './lib/guard.js';
import { maskAccount } from './lib/normalize.js';
import { canBrowse, filterVisible as visibleKeys } from './lib/jira.js';

const describeReasons = (reasons) =>
  reasons.map((reason) => ({ rule: reason.code, explanation: reason.message, relatedWorkItems: reason.relatedKeys }));

export async function checkInvoice(payload) {
  const invoice = {
    vendor: String(payload?.vendor ?? '').trim(),
    invoiceNo: String(payload?.invoiceNo ?? '').trim(),
    amount: String(payload?.amount ?? '').trim(),
    currency: String(payload?.currency ?? '').trim().toUpperCase(),
    invoiceDate: String(payload?.invoiceDate ?? '').trim(),
    bankAccount: String(payload?.bankAccount ?? '').trim(),
  };
  // A key that cannot exist, so the invoice is compared with every recorded one.
  const result = await evaluateIssue('__preview__', invoice);
  const cache = new Map();
  for (const reason of result.reasons) reason.relatedKeys = await visibleKeys(reason.relatedKeys, cache);
  return {
    decision: result.status === 'HOLD' ? 'WOULD BE HELD — do not pay yet' : 'CLEAR — all checks pass',
    reasons: describeReasons(result.reasons),
    note: 'Nothing was saved. Record the invoice in the Payment Guard panel of its work item to apply the hold.',
  };
}

export async function listHolds() {
  const holds = (await store.listHolds()).filter((hold) => hold.status === 'held');
  const cache = new Map();
  const visible = [];
  for (const hold of holds) {
    if ((await visibleKeys([hold.issueKey], cache)).length === 0) continue;
    visible.push({
      workItem: hold.issueKey,
      vendor: hold.vendor || '',
      onHoldSince: hold.heldAt ? new Date(hold.heldAt).toISOString() : '',
      rules: hold.reasons.map((reason) => reason.code),
    });
  }
  const changes = (await store.listBankChanges()).filter((change) => !change.verifiedAt);
  const pendingBankChanges = [];
  for (const change of changes) {
    if ((await visibleKeys([change.issueKey], cache)).length === 0) continue;
    pendingBankChanges.push({ workItem: change.issueKey, vendor: change.vendor, newAccount: maskAccount(change.newAccount) });
  }
  return { onHold: visible, count: visible.length, pendingBankChanges };
}

export async function explainHold(payload) {
  const issueKey = String(payload?.issueKey ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) return { error: `"${issueKey}" is not a work item key (example: AP-12).` };
  if (!(await canBrowse(issueKey))) return { error: `You cannot see ${issueKey}, or it does not exist.` };
  const hold = await store.getHold(issueKey);
  if (!hold) return { workItem: issueKey, status: 'NOT CHECKED', explanation: 'No invoice has been recorded on this work item.' };
  const cache = new Map();
  const reasons = [];
  for (const reason of hold.reasons || []) {
    reasons.push({ ...reason, relatedKeys: await visibleKeys(reason.relatedKeys, cache) });
  }
  return {
    workItem: issueKey,
    status: hold.status === 'held' ? 'ON HOLD' : hold.status === 'clear' ? 'CLEAR' : 'RELEASED BY A PERSON',
    reasons: describeReasons(reasons),
    release:
      hold.status === 'released'
        ? { releasedAt: new Date(hold.releasedAt).toISOString(), reason: hold.releaseReason }
        : undefined,
    howToRelease:
      hold.status === 'held'
        ? 'Only a person can release a hold: open the work item, Payment Guard panel, "Release hold", and write a reason.'
        : undefined,
  };
}

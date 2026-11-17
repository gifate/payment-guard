/**
 * Storage layer. Everything Payment Guard remembers lives in Forge Key-Value
 * Storage (KVS), which runs on Atlassian's infrastructure and is only reachable
 * from the app's backend (asApp). Keys:
 *
 *   inv:<issueKey>      invoice data recorded on a work item
 *   chg:<issueKey>      a vendor bank-account change request
 *   bank:<vendorKey>    the verified bank account of a vendor
 *   hold:<issueKey>     the current guard decision for a work item
 *   audit:<issueKey>:<time>  one audit-trail entry
 *   settings            app settings (waiting period)
 *
 * The data set of an accounts-payable team using JSM is small, so listing a
 * prefix and filtering in memory is acceptable here. A very large customer
 * would move to Forge Custom Entities with indexes.
 */
import { kvs, WhereConditions } from '@forge/kvs';

// requireSecondPerson is off by default so a single evaluator can try the whole
// flow alone; real teams should switch it on (segregation of duties).
export const DEFAULT_SETTINGS = { coolingDays: 3, requireSecondPerson: false };

/** Reads every value whose key starts with `prefix`. */
async function listByPrefix(prefix) {
  const items = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    items.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export const getInvoice = (issueKey) => kvs.get(`inv:${issueKey}`);
export const setInvoice = (issueKey, value) => kvs.set(`inv:${issueKey}`, value);
export async function listInvoices() {
  const items = await listByPrefix('inv:');
  return items.map((item) => ({ issueKey: item.key.slice(4), ...item.value }));
}

export const getBankChange = (issueKey) => kvs.get(`chg:${issueKey}`);
export const setBankChange = (issueKey, value) => kvs.set(`chg:${issueKey}`, value);
export async function listBankChanges() {
  const items = await listByPrefix('chg:');
  return items.map((item) => ({ issueKey: item.key.slice(4), ...item.value }));
}

export const getVerifiedBank = (vendorKey) => kvs.get(`bank:${vendorKey}`);
export const setVerifiedBank = (vendorKey, value) => kvs.set(`bank:${vendorKey}`, value);

export const getHold = (issueKey) => kvs.get(`hold:${issueKey}`);
export const setHold = (issueKey, value) => kvs.set(`hold:${issueKey}`, value);
export async function listHolds() {
  const items = await listByPrefix('hold:');
  return items.map((item) => ({ issueKey: item.key.slice(5), ...item.value }));
}

/** Appends one audit entry. Entries are never edited or deleted by the app. */
export async function addAudit(issueKey, entry) {
  const at = Date.now();
  // Zero-padded time keeps entries sorted by key.
  await kvs.set(`audit:${issueKey}:${String(at).padStart(15, '0')}`, { at, ...entry });
}
export async function listAudit(issueKey) {
  const items = await listByPrefix(`audit:${issueKey}:`);
  return items.map((item) => item.value).sort((a, b) => a.at - b.at);
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await kvs.get('settings')) || {}) };
}
export const setSettings = (value) => kvs.set('settings', value);

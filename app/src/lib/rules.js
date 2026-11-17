/**
 * The guard rules. This file is pure logic (no Forge or network calls) so it
 * can be unit-tested with plain Node and reused by Rovo / MCP actions later.
 *
 * Design rule: when anything looks wrong, HOLD. A person can always release a
 * hold with a written reason; a payment that went out cannot be taken back.
 */
import {
  normalizeInvoiceNo,
  normalizeVendor,
  normalizeAccount,
  parseAmount,
  maskAccount,
} from './normalize.js';

export const DUPLICATE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fields an invoice must have before it can be cleared for payment. */
export const REQUIRED_FIELDS = ['vendor', 'invoiceNo', 'amount', 'invoiceDate', 'bankAccount'];

/**
 * Returns a list of missing required field names (empty when complete).
 */
export function missingFields(invoice) {
  return REQUIRED_FIELDS.filter((field) => {
    if (field === 'amount') return Number.isNaN(parseAmount(invoice.amount));
    return String(invoice[field] ?? '').trim() === '';
  });
}

/**
 * Evaluates one invoice against everything Payment Guard knows.
 *
 * @param {object} input
 * @param {string} input.issueKey        Key of the work item being checked.
 * @param {object} input.invoice         { vendor, invoiceNo, amount, currency, invoiceDate, bankAccount }
 * @param {Array}  input.otherInvoices   [{ issueKey, invoice, released }] other recorded invoices.
 * @param {object|null} input.verifiedBank   { account, verifiedAt, verifiedBy } for this vendor, or null.
 * @param {Array}  input.bankChanges     [{ issueKey, newAccount, verifiedAt|null }] for this vendor.
 * @param {number} input.coolingDays     Days to wait after a bank change is verified.
 * @param {number} input.now             Current time (ms), injectable for tests.
 * @returns {{ status: 'HOLD'|'CLEAR', reasons: Array<{code, message, relatedKeys}> }}
 */
export function evaluateInvoice({
  issueKey,
  invoice,
  otherInvoices = [],
  verifiedBank = null,
  bankChanges = [],
  coolingDays = 3,
  now = Date.now(),
}) {
  const reasons = [];

  // E — incomplete data. We still run the other checks on what we have.
  const missing = missingFields(invoice);
  if (missing.length > 0) {
    reasons.push({
      code: 'E',
      message: `Missing required fields: ${missing.join(', ')}.`,
      relatedKeys: [],
    });
  }

  const vendor = normalizeVendor(invoice.vendor);
  const number = normalizeInvoiceNo(invoice.invoiceNo);
  const amount = parseAmount(invoice.amount);
  const date = Date.parse(invoice.invoiceDate);
  const account = normalizeAccount(invoice.bankAccount);

  // Only compare against other invoices from the same vendor that were recorded
  // EARLIER than this one: the first invoice is the original, only later copies
  // are suspicious. (Invoices without a timestamp — e.g. a preview — compare
  // against everything.)
  const mine = invoice.recordedAt ?? Infinity;
  const sameVendor = otherInvoices.filter(
    (other) =>
      other.issueKey !== issueKey &&
      vendor !== '' &&
      normalizeVendor(other.invoice.vendor) === vendor &&
      (other.invoice.recordedAt ?? -Infinity) < mine
  );

  // D1 — same vendor + same invoice number (after normalisation).
  const sameNumber = sameVendor.filter(
    (other) => number !== '' && normalizeInvoiceNo(other.invoice.invoiceNo) === number
  );
  if (sameNumber.length > 0) {
    reasons.push({
      code: 'D1',
      message: `Invoice number "${invoice.invoiceNo}" from this vendor is already recorded.`,
      relatedKeys: sameNumber.map((other) => other.issueKey),
    });
  }

  // D2 — same vendor + same amount + invoice dates close together, different number.
  if (!Number.isNaN(amount) && !Number.isNaN(date)) {
    const sameAmount = sameVendor.filter((other) => {
      if (sameNumber.includes(other)) return false; // already reported by D1
      const otherDate = Date.parse(other.invoice.invoiceDate);
      return (
        parseAmount(other.invoice.amount) === amount &&
        (other.invoice.currency || '') === (invoice.currency || '') &&
        !Number.isNaN(otherDate) &&
        Math.abs(otherDate - date) <= DUPLICATE_WINDOW_DAYS * DAY_MS
      );
    });
    if (sameAmount.length > 0) {
      reasons.push({
        code: 'D2',
        message: `Same amount from this vendor within ${DUPLICATE_WINDOW_DAYS} days under a different invoice number.`,
        relatedKeys: sameAmount.map((other) => other.issueKey),
      });
    }
  }

  // B2 — pending or too-recent bank-account change for this vendor.
  const pending = bankChanges.filter((change) => !change.verifiedAt);
  if (pending.length > 0) {
    reasons.push({
      code: 'B2',
      message: 'This vendor has a bank-account change request that has not been verified by call-back.',
      relatedKeys: pending.map((change) => change.issueKey),
    });
  }
  const recent = bankChanges.filter(
    (change) => change.verifiedAt && now - change.verifiedAt < coolingDays * DAY_MS
  );
  if (recent.length > 0) {
    reasons.push({
      code: 'B2',
      message: `This vendor's bank account changed less than ${coolingDays} days ago (waiting period).`,
      relatedKeys: recent.map((change) => change.issueKey),
    });
  }

  // B1 — invoice bank account vs. the verified account on record.
  if (account !== '') {
    if (!verifiedBank) {
      reasons.push({
        code: 'B1',
        message: 'No verified bank account on record for this vendor yet. Verify it by call-back before the first payment.',
        relatedKeys: [],
      });
    } else if (normalizeAccount(verifiedBank.account) !== account) {
      reasons.push({
        code: 'B1',
        message: `Bank account on the invoice (${maskAccount(account)}) differs from the verified account (${maskAccount(verifiedBank.account)}).`,
        relatedKeys: [],
      });
    }
  }

  return { status: reasons.length > 0 ? 'HOLD' : 'CLEAR', reasons };
}

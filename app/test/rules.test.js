// Unit tests for the pure guard logic. Run with:  node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInvoiceNo, normalizeVendor, normalizeAccount, parseAmount } from '../src/lib/normalize.js';
import { evaluateInvoice } from '../src/lib/rules.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-14T00:00:00Z');

const base = {
  vendor: 'Acme Supplies, Inc.',
  invoiceNo: 'INV-0042',
  amount: '1,200.00',
  currency: 'USD',
  invoiceDate: '2026-11-01',
  bankAccount: 'GB29 NWBK 6016 1331 9268 19',
};
const verified = { account: 'GB29NWBK60161331926819', verifiedAt: NOW - 100 * DAY };

test('invoice numbers ignore case, separators, full-width and padding zeros', () => {
  assert.equal(normalizeInvoiceNo('INV-0042'), 'INV42');
  assert.equal(normalizeInvoiceNo('inv 42'), 'INV42');
  assert.equal(normalizeInvoiceNo('ＩＮＶ－００４２'), 'INV42');
  assert.equal(normalizeInvoiceNo('2024/00017'), '202417');
  assert.notEqual(normalizeInvoiceNo('INV-420'), normalizeInvoiceNo('INV-42'));
});

test('vendor names ignore legal forms and punctuation', () => {
  assert.equal(normalizeVendor('Acme Supplies, Inc.'), 'acmesupplies');
  assert.equal(normalizeVendor('ACME SUPPLIES LTD'), 'acmesupplies');
  assert.equal(normalizeVendor('株式会社　みなと商事'), 'みなと商事');
  assert.equal(normalizeVendor('みなと商事(株)'), 'みなと商事');
  assert.equal(normalizeVendor('Cooper Tools'), 'coopertools');
});

test('accounts and amounts', () => {
  assert.equal(normalizeAccount('gb29 nwbk-6016'), 'GB29NWBK6016');
  assert.equal(parseAmount('¥120,000'), 120000);
  assert.equal(parseAmount('１２００.5'), 1200.5);
  assert.ok(Number.isNaN(parseAmount('')));
});

test('clean invoice with verified bank is CLEAR', () => {
  const result = evaluateInvoice({ issueKey: 'AP-1', invoice: base, verifiedBank: verified, now: NOW });
  assert.equal(result.status, 'CLEAR');
  assert.deepEqual(result.reasons, []);
});

test('D1: same vendor + same number written differently is held', () => {
  const result = evaluateInvoice({
    issueKey: 'AP-2',
    invoice: { ...base, vendor: 'ACME SUPPLIES LTD', invoiceNo: 'inv 42' },
    otherInvoices: [{ issueKey: 'AP-1', invoice: base }],
    verifiedBank: verified,
    now: NOW,
  });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.reasons[0].code, 'D1');
  assert.deepEqual(result.reasons[0].relatedKeys, ['AP-1']);
});

test('D2: same amount within 30 days with a different number is held', () => {
  const result = evaluateInvoice({
    issueKey: 'AP-3',
    invoice: { ...base, invoiceNo: 'INV-0043', invoiceDate: '2026-11-10' },
    otherInvoices: [{ issueKey: 'AP-1', invoice: base }],
    verifiedBank: verified,
    now: NOW,
  });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.reasons[0].code, 'D2');
});

test('D2 does not fire outside the window or for another vendor', () => {
  const far = evaluateInvoice({
    issueKey: 'AP-4',
    invoice: { ...base, invoiceNo: 'INV-0050', invoiceDate: '2026-12-20' },
    otherInvoices: [{ issueKey: 'AP-1', invoice: base }],
    verifiedBank: verified,
    now: NOW,
  });
  assert.equal(far.status, 'CLEAR');
  const other = evaluateInvoice({
    issueKey: 'AP-5',
    invoice: { ...base, vendor: 'Globex' },
    otherInvoices: [{ issueKey: 'AP-1', invoice: base }],
    verifiedBank: { account: base.bankAccount, verifiedAt: 0 },
    now: NOW,
  });
  assert.equal(other.status, 'CLEAR');
});

test('B1: first payment to a vendor without a verified account is held', () => {
  const result = evaluateInvoice({ issueKey: 'AP-6', invoice: base, now: NOW });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.reasons[0].code, 'B1');
});

test('B1: account differing from the verified one is held', () => {
  const result = evaluateInvoice({
    issueKey: 'AP-7',
    invoice: { ...base, bankAccount: 'DE89 3704 0044 0532 0130 00' },
    verifiedBank: verified,
    now: NOW,
  });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.reasons[0].code, 'B1');
  assert.match(result.reasons[0].message, /••••3000/);
});

test('B2: pending and recently verified bank changes hold payments', () => {
  const pending = evaluateInvoice({
    issueKey: 'AP-8',
    invoice: base,
    verifiedBank: verified,
    bankChanges: [{ issueKey: 'AP-9', newAccount: 'X', verifiedAt: null }],
    now: NOW,
  });
  assert.equal(pending.status, 'HOLD');
  assert.equal(pending.reasons[0].code, 'B2');

  const recent = evaluateInvoice({
    issueKey: 'AP-8',
    invoice: base,
    verifiedBank: verified,
    bankChanges: [{ issueKey: 'AP-9', newAccount: base.bankAccount, verifiedAt: NOW - 1 * DAY }],
    coolingDays: 3,
    now: NOW,
  });
  assert.equal(recent.status, 'HOLD');

  const old = evaluateInvoice({
    issueKey: 'AP-8',
    invoice: base,
    verifiedBank: verified,
    bankChanges: [{ issueKey: 'AP-9', newAccount: base.bankAccount, verifiedAt: NOW - 5 * DAY }],
    coolingDays: 3,
    now: NOW,
  });
  assert.equal(old.status, 'CLEAR');
});

test('only the later copy is flagged, not the original', () => {
  const original = { ...base, recordedAt: NOW - 2 * DAY };
  const copy = { ...base, invoiceNo: 'inv 42', recordedAt: NOW - 1 * DAY };
  const forOriginal = evaluateInvoice({
    issueKey: 'AP-1',
    invoice: original,
    otherInvoices: [{ issueKey: 'AP-2', invoice: copy }],
    verifiedBank: verified,
    now: NOW,
  });
  assert.equal(forOriginal.status, 'CLEAR');
  const forCopy = evaluateInvoice({
    issueKey: 'AP-2',
    invoice: copy,
    otherInvoices: [{ issueKey: 'AP-1', invoice: original }],
    verifiedBank: verified,
    now: NOW,
  });
  assert.equal(forCopy.status, 'HOLD');
  assert.equal(forCopy.reasons[0].code, 'D1');
});

test('E: missing fields hold the invoice', () => {
  const result = evaluateInvoice({
    issueKey: 'AP-10',
    invoice: { ...base, amount: '', bankAccount: '' },
    verifiedBank: verified,
    now: NOW,
  });
  assert.equal(result.status, 'HOLD');
  assert.equal(result.reasons[0].code, 'E');
  assert.match(result.reasons[0].message, /amount, bankAccount/);
});

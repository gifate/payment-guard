// Unit tests for reading invoice data out of e-mail / portal text. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromText, normalizeDate, splitAmount, adfToText } from '../src/lib/parse.js';

test('dates in common formats', () => {
  assert.equal(normalizeDate('2026-11-01'), '2026-11-01');
  assert.equal(normalizeDate('2026/11/1'), '2026-11-01');
  assert.equal(normalizeDate('2026年11月1日'), '2026-11-01');
  assert.equal(normalizeDate('1 Nov 2026'), '2026-11-01');
  assert.equal(normalizeDate('November 1st, 2026'), '2026-11-01');
  assert.equal(normalizeDate('25/11/2026'), '2026-11-25');
  assert.equal(normalizeDate('11/25/2026'), '2026-11-25');
  assert.equal(normalizeDate('01/11/2026'), '', 'ambiguous D/M vs M/D is not guessed');
});

test('amounts and currencies', () => {
  assert.deepEqual(splitAmount('USD 1,200.00'), { amount: '1200.00', currency: 'USD' });
  assert.deepEqual(splitAmount('$8,450.00'), { amount: '8450.00', currency: 'USD' });
  assert.deepEqual(splitAmount('1.200,50 EUR'), { amount: '1200.50', currency: 'EUR' });
  assert.deepEqual(splitAmount('120,000円'), { amount: '120000', currency: 'JPY' });
});

test('an e-mailed invoice is recognised', () => {
  const description = [
    'Hello AP team,',
    'please find our invoice below.',
    'Vendor: Bluefin Office Supplies, Inc.',
    'Invoice number: BF-0042',
    'Invoice date: 2 Nov 2026',
    'Amount due: USD 8,450.00',
    'IBAN: GB82 WEST 1234 5698 7654 32',
    'Thank you',
  ].join('\n');
  const result = extractFromText('Invoice BF-0042', description);
  assert.equal(result.kind, 'invoice');
  assert.deepEqual(result.invoice, {
    vendor: 'Bluefin Office Supplies, Inc.',
    invoiceNo: 'BF-0042',
    amount: '8450.00',
    currency: 'USD',
    invoiceDate: '2026-11-02',
    bankAccount: 'GB82 WEST 1234 5698 7654 32',
  });
});

test('a Japanese invoice e-mail is recognised', () => {
  const result = extractFromText('請求書の送付', '取引先：みなと商事株式会社\n請求書番号：A-0007\n請求日：2026年11月5日\n請求金額：120,000円\n振込先：JP12 3456 7890 1234');
  assert.equal(result.kind, 'invoice');
  assert.equal(result.invoice.vendor, 'みなと商事株式会社');
  assert.equal(result.invoice.invoiceNo, 'A-0007');
  assert.equal(result.invoice.amount, '120000');
  assert.equal(result.invoice.currency, 'JPY');
  assert.equal(result.invoice.invoiceDate, '2026-11-05');
});

test('a bank-detail change e-mail is recognised as a bank change', () => {
  const result = extractFromText(
    'Please update our bank details',
    'Dear customer,\nOur bank details have changed. Please use our new bank account for all future payments.\nVendor: Bluefin Office Supplies\nIBAN: LT12 1000 0111 0100 1000\nRegards'
  );
  assert.equal(result.kind, 'bank-change');
  assert.deepEqual(result.change, { vendor: 'Bluefin Office Supplies', newAccount: 'LT12 1000 0111 0100 1000' });
});

test('ordinary requests are ignored', () => {
  assert.equal(extractFromText('Laptop is broken', 'My laptop does not start since this morning.').kind, 'none');
  assert.equal(extractFromText('Question', 'What is the total budget for Q4?').kind, 'none');
});

test('ADF to text keeps one line per paragraph', () => {
  const adf = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Invoice number: X-1' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Amount: 10' }, { type: 'hardBreak' }, { type: 'text', text: 'Vendor: A' }] },
    ],
  };
  assert.equal(adfToText(adf), 'Invoice number: X-1\nAmount: 10\nVendor: A\n');
  const result = extractFromText('', adfToText(adf));
  assert.equal(result.kind, 'invoice');
  assert.equal(result.invoice.vendor, 'A');
});

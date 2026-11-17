/**
 * Reads invoice data and bank-change requests out of free text (the summary and
 * description of a new work item — typically an e-mail sent to the JSM channel
 * or a portal request). Pure logic: no Forge calls, unit-tested.
 *
 * We only act on text that is labelled, e.g. "Invoice number: INV-0042".
 * Guessing from unlabelled text would create noise; a missing field simply
 * becomes rule E (missing data) and the clerk completes it in the panel.
 */

const fold = (value) => String(value ?? '').normalize('NFKC');

/** Converts Atlassian Document Format (ADF) to plain text, one line per block. */
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfToText).join('');
  const blocks = ['paragraph', 'heading', 'listItem', 'tableRow', 'blockquote', 'codeBlock'];
  return blocks.includes(node.type) ? `${inner}\n` : inner;
}

/** Finds the value after the first matching label ("Label: value" up to end of line). */
function labelled(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`(?:^|\\n)\\s*[-*•]?\\s*(?:${label})\\s*(?:[:：#=]|\\bis\\b)\\s*([^\\n]+)`, 'i');
    const match = text.match(re);
    // Keep a final "." ("Inc.") — matching ignores punctuation anyway.
    if (match) return match[1].trim().replace(/[;,]\s*$/, '');
  }
  return '';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

/**
 * Normalises a date to YYYY-MM-DD. Accepts 2026-11-01, 2026/11/01, 2026年11月1日,
 * 1 Nov 2026, Nov 1, 2026, November 1 2026. Numeric D/M/Y vs M/D/Y is ambiguous,
 * so 01/11/2026 is only accepted when one part is > 12; otherwise returns ''.
 */
export function normalizeDate(value) {
  const text = fold(value).trim();
  let m = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = text.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s*,?\s+(\d{4})/);
  if (m && MONTHS.includes(m[2].toLowerCase())) return `${m[3]}-${pad(MONTHS.indexOf(m[2].toLowerCase()) + 1)}-${pad(m[1])}`;
  m = text.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{4})/);
  if (m && MONTHS.includes(m[1].toLowerCase())) return `${m[3]}-${pad(MONTHS.indexOf(m[1].toLowerCase()) + 1)}-${pad(m[2])}`;
  m = text.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) return `${m[3]}-${pad(b)}-${pad(a)}`;
    if (b > 12 && a <= 12) return `${m[3]}-${pad(a)}-${pad(b)}`;
  }
  return '';
}

const CURRENCY_SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '円': 'JPY' };

/** Splits "USD 1,200.00" / "$1,200.00" / "1.200,00 EUR" / "120,000円" into amount + currency. */
export function splitAmount(value) {
  const text = fold(value);
  let currency = (text.match(/\b(USD|EUR|GBP|JPY|AUD|CAD|CHF|SGD|NZD)\b/i) || [])[1]?.toUpperCase() || '';
  if (!currency) {
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
      if (text.includes(symbol)) {
        currency = code;
        break;
      }
    }
  }
  const numberText = (text.match(/\d[\d.,\s]*/) || [''])[0].trim();
  // "1.200,50" (European) -> "1200.50"; "1,200.50" -> "1200.50"
  let amount = numberText.replace(/\s/g, '');
  if (/,\d{2}$/.test(amount) && amount.includes('.')) amount = amount.replace(/\./g, '').replace(',', '.');
  else if (/,\d{2}$/.test(amount) && !amount.includes('.')) amount = amount.replace(',', '.');
  else amount = amount.replace(/,/g, '');
  return { amount, currency };
}

const IBAN_RE = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{2,4}){3,8})\b/;

const BANK_CHANGE_RE =
  /(new|updated?|change[sd]?( of)?|changing)\s+(our\s+)?(bank|banking|payment|remittance)\s+(details|account|information|info)|(bank|banking)\s+(details|account)\s+(have|has)\s+changed|口座(の)?(変更|変わ)|振込先(の)?変更/i;

/**
 * Extracts what Payment Guard needs from summary + description.
 * @returns {{ kind: 'invoice'|'bank-change'|'none', invoice?: object, change?: object, found: string[] }}
 */
export function extractFromText(summary, description) {
  const text = `${fold(summary)}\n${fold(description)}`;
  const vendor = labelled(text, ['vendor', 'supplier', 'company', 'from company', 'payee', '取引先', '請求元', '会社名']);
  const invoiceNo = labelled(text, ['invoice\\s*(?:no\\.?|number|num|#|id)', 'inv\\.?\\s*(?:no\\.?|#)', '請求書番号', '請求番号']);
  const amountRaw = labelled(text, ['amount\\s*due', 'total\\s*due', 'invoice\\s*total', 'total', 'amount', '請求金額', '合計', '金額']);
  const dateRaw = labelled(text, ['invoice\\s*date', 'date\\s*of\\s*invoice', 'issue\\s*date', 'date', '請求日', '発行日']);
  const accountRaw =
    labelled(text, ['iban', 'bank\\s*account(?:\\s*(?:no\\.?|number))?', 'account\\s*(?:no\\.?|number)', 'pay\\s*to', '振込先', '口座番号']) ||
    (text.match(IBAN_RE) || [])[1] ||
    '';
  const account = (fold(accountRaw).toUpperCase().match(IBAN_RE) || [])[1] || accountRaw;
  const { amount, currency } = splitAmount(amountRaw);
  const invoiceDate = normalizeDate(dateRaw);

  const found = Object.entries({ vendor, invoiceNo, amount, invoiceDate, bankAccount: account })
    .filter(([, v]) => v)
    .map(([k]) => k);

  // A bank-change request: change wording + a new account + a vendor name.
  if (BANK_CHANGE_RE.test(text) && account && vendor && !invoiceNo) {
    return { kind: 'bank-change', change: { vendor, newAccount: account }, found };
  }
  // An invoice: we need at least an invoice number and an amount to be confident.
  if (invoiceNo && amount) {
    return {
      kind: 'invoice',
      invoice: { vendor, invoiceNo, amount, currency, invoiceDate, bankAccount: account },
      found,
    };
  }
  return { kind: 'none', found };
}

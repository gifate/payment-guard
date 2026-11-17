/**
 * Normalisation helpers.
 *
 * Accounts-payable data is typed by people, so the same invoice often arrives
 * written in slightly different ways ("INV-0042", "inv 42", "ＩＮＶ００４２").
 * Every comparison in Payment Guard goes through these helpers so that cosmetic
 * differences never hide a duplicate.
 */

/**
 * Unicode NFKC folds full-width characters (common in Japanese input) into
 * their ASCII equivalents, e.g. "ＩＮＶ－００４２" -> "INV-0042".
 */
const fold = (value) => String(value ?? '').normalize('NFKC');

/**
 * Invoice numbers: ignore case, separators and leading zeros of each number.
 *   "INV-0042"   -> "INV42"
 *   "inv 42"     -> "INV42"
 *   "2024/00017" -> "202417"
 */
export function normalizeInvoiceNo(value) {
  // Split into runs of letters and runs of digits; everything else (spaces,
  // hyphens, slashes, dots ...) is a separator and disappears.
  const tokens = fold(value).toUpperCase().match(/[A-Z]+|\d+/g) || [];
  // Remove zeros that only pad a number ("0042" -> "42"), per number, so
  // "2024/00017" becomes "2024" + "17" rather than "202400017".
  return tokens.map((token) => (/^\d+$/.test(token) ? token.replace(/^0+(?=\d)/, '') : token)).join('');
}

// Legal-form words that do not identify a vendor. Compared after lower-casing.
const LEGAL_FORMS = [
  '株式会社', '有限会社', '合同会社', '(株)', '（株）', '㈱', '(有)', '㈲',
  'incorporated', 'corporation', 'company', 'limited',
  'inc', 'ltd', 'llc', 'corp', 'co', 'gmbh', 'plc', 'kk', 'pty',
];

/**
 * Vendor names: ignore case, punctuation, spaces and legal-form words.
 *   "Acme Supplies, Inc."  -> "acmesupplies"
 *   "ACME SUPPLIES LTD"    -> "acmesupplies"
 *   "株式会社　みなと商事"    -> "みなと商事"
 */
export function normalizeVendor(value) {
  let text = fold(value).toLowerCase();
  for (const form of LEGAL_FORMS) {
    if (/^[a-z]+$/.test(form)) {
      // Latin words: only remove them as whole words, so "cooper" keeps its "co".
      text = text.replace(new RegExp(`\\b${form}\\b\\.?`, 'g'), ' ');
    } else {
      text = text.split(form).join(' ');
    }
  }
  // Keep letters and digits from any script (Latin, Japanese, ...).
  return text.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Bank accounts / IBANs: compare digits and letters only.
 *   "GB29 NWBK 6016 1331 9268 19" -> "GB29NWBK60161331926819"
 */
export function normalizeAccount(value) {
  return fold(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Amounts: accept "1,200.50", "¥120,000" or "１２００". Returns a number rounded
 * to 2 decimals, or NaN when the text is not a usable amount.
 */
export function parseAmount(value) {
  const text = fold(value).replace(/[^0-9.\-]/g, '');
  if (text === '' || text === '-' || text === '.') return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : NaN;
}

/** Masks an account for display so the full number is never shown in lists. */
export function maskAccount(value) {
  const account = normalizeAccount(value);
  if (account.length <= 4) return account;
  return `••••${account.slice(-4)}`;
}

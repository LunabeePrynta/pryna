// India Post (UPU S10) article number: 2 letters + 8 digit serial + check digit + "IN".
// Check digit uses the "weighted modulus 11" rule from the Department of Posts barcode spec.

const WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7];
const BARCODE_RE = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

export function checkDigit(serial) {
  const digits = String(serial);
  if (!/^\d{8}$/.test(digits)) throw new Error(`Serial must be 8 digits, got "${serial}"`);
  const sum = [...digits].reduce((acc, d, i) => acc + Number(d) * WEIGHTS[i], 0);
  const remainder = sum % 11;
  if (remainder === 0) return 5;
  if (remainder === 1) return 0;
  return 11 - remainder;
}

export function buildBarcode(prefix, serial, country = 'IN') {
  if (!/^[A-Z]{2}$/.test(prefix)) throw new Error(`Barcode prefix must be 2 letters, got "${prefix}"`);
  const digits = String(serial).padStart(8, '0');
  return `${prefix}${digits}${checkDigit(digits)}${country}`;
}

export function isValidBarcode(value) {
  const barcode = normalizeBarcode(value);
  if (!BARCODE_RE.test(barcode)) return false;
  return checkDigit(barcode.slice(2, 10)) === Number(barcode[10]);
}

export function normalizeBarcode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Parses an AWB series as printed by India Post, e.g. "ET21433001XIN" → { prefix: 'ET', serial: 21433001 }.
 * The check digit position may be written as X.
 */
export function parseSeriesBoundary(value) {
  const match = /^([A-Z]{2})(\d{8})[\dX]?(?:IN)?$/i.exec(String(value ?? '').trim());
  if (!match) throw new Error(`Invalid AWB series boundary "${value}" (expected e.g. ET21433001XIN)`);
  return { prefix: match[1].toUpperCase(), serial: Number(match[2]) };
}

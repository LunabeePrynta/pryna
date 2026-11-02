'use strict';

// India Post (UPU S10): 2 letters + 9 digits + "IN", e.g. EE123456789IN
const INDIA_POST_RE = /^[A-Z]{2}\d{9}IN$/;
// Ekart / Flipkart shipments: 4-letter prefix + digits, e.g. FMPP1234567890.
// Extend via EKART_PREFIXES env (comma separated) if you see other prefixes.
const DEFAULT_EKART_PREFIXES = ['FMPP', 'FMPC', 'FMPR', 'FMPS', 'FMPJ', 'FMPD', 'MYSP', 'VSPP', 'EKRT'];

const INDIA_POST_URL =
  'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx';

function normalize(code) {
  return String(code || '').toUpperCase().replace(/[\s-]/g, '');
}

function detectCarrier(raw, env = process.env) {
  const code = normalize(raw);
  if (!code) return { carrier: 'invalid', code };
  if (INDIA_POST_RE.test(code)) return { carrier: 'indiapost', code };
  const prefixes = (env.EKART_PREFIXES ? env.EKART_PREFIXES.split(',') : DEFAULT_EKART_PREFIXES)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  if (/^[A-Z]{4}[A-Z0-9]{6,12}$/.test(code) && prefixes.some((p) => code.startsWith(p))) {
    return { carrier: 'ekart', code };
  }
  return { carrier: 'unknown', code };
}

module.exports = { detectCarrier, normalize, INDIA_POST_URL };

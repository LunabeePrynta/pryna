import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBarcode, checkDigit, isValidBarcode, parseSeriesBoundary } from '../src/indiapost/barcode.js';

test('check digit follows the weighted modulus 11 example in the spec', () => {
  assert.equal(checkDigit('47312482'), 9);
});

test('remainder 0 gives 5 and remainder 1 gives 0', () => {
  // 00000000 → sum 0 → remainder 0 → 5
  assert.equal(checkDigit('00000000'), 5);
  // 00060000 → 6 × 2 = 12 → remainder 1 → 0
  assert.equal(checkDigit('00060000'), 0);
});

test('validates real India Post article numbers', () => {
  assert.equal(isValidBarcode('RK775227016IN'), true);
  assert.equal(isValidBarcode('rk775227016in'), true);
  assert.equal(isValidBarcode('RK775227017IN'), false);
  assert.equal(isValidBarcode('RK77522701IN'), false);
});

test('builds barcodes from the UAT AWB series', () => {
  const start = parseSeriesBoundary('ET21433001XIN');
  assert.deepEqual(start, { prefix: 'ET', serial: 21433001 });
  const barcode = buildBarcode(start.prefix, start.serial);
  assert.match(barcode, /^ET21433001\dIN$/);
  assert.equal(isValidBarcode(barcode), true);
  assert.throws(() => parseSeriesBoundary('XYZ'));
});

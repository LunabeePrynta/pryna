import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArticle,
  chooseArticleType,
  normalizeMobile,
  sanitizeOverrides,
  pickupScheduleDate,
  splitAddress,
  defaultSettings,
  mergeSettings,
} from '../src/indiapost/mapper.js';
import { sampleOrder, sampleSettings } from './fixtures.js';

test('speed post switches between document and parcel at 500 g', () => {
  assert.equal(chooseArticleType('SPEED_POST', 500), 'SP_INLAND_DOC');
  assert.equal(chooseArticleType('SPEED_POST', 501), 'SP_INLAND_PARCEL');
  assert.equal(chooseArticleType('BUSINESS_PARCEL', 100), 'BUSINESS_PARCEL');
});

test('normalizes Indian mobile numbers', () => {
  assert.equal(normalizeMobile('+91 98765 43210'), '9876543210');
  assert.equal(normalizeMobile('09876543210'), '9876543210');
  assert.equal(normalizeMobile('5876543210'), null);
  assert.equal(normalizeMobile(''), null);
});

test('splits long addresses into three 80 character lines', () => {
  const long = 'A'.repeat(10) + ' ' + 'word '.repeat(40);
  const lines = splitAddress(long, 'Near Temple');
  assert.equal(lines.length, 3);
  lines.forEach((l) => assert.ok(l.length <= 80));
  assert.ok(lines.join('').length <= 240);
  assert.deepEqual(splitAddress('12 MG Road', 'x'), ['12 MG Road x', '', '']);
});

test('address lines have no dots or commas', () => {
  const { article } = buildArticle(
    sampleOrder(),
    sampleSettings({ sender: { ...sampleSettings().sender, address1: 'No. 12, M.G. Road', address2: 'Near Bus Stand.' } }),
    'ET214330015IN',
  );
  assert.equal(article.receiver_add_line_1, 'Flat 4B Green Residency 2nd Cross');
  assert.equal(article.sender_add_line_1, 'No 12 M G Road');
  assert.equal(article.sender_add_line_2, 'Near Bus Stand');
  assert.equal(article.prepayment_code, '');
  assert.equal(article.value_of_prepayment, 0);
});

test('builds a valid parcel article from a paid order', () => {
  const { article, errors } = buildArticle(sampleOrder(), sampleSettings(), 'ET214330015IN');
  assert.deepEqual(errors, []);
  assert.equal(article.article_type, 'SP_INLAND_PARCEL');
  assert.equal(article.contract_id, '41585456');
  assert.equal(article.physical_weight, 800);
  assert.equal(article.shape_of_article, 'NROL');
  assert.equal(article.pickup_or_dropoff, 'DROPOFF');
  assert.equal(article.pickup_dropoff_office_id, 21260024);
  assert.equal(article.receiver_mobile_no, '9876501234');
  assert.equal(article.sender_mobile_no, '9876543210');
  assert.equal(article.receiver_pincode, '560038');
  assert.equal(article.drop_off_pincode, '600001');
  assert.equal(article.codr_cod, '');
  assert.equal(article.bulk_reference, '#1001');
});

test('every order is booked prepaid, even an unpaid cash-on-delivery order', () => {
  const order = sampleOrder({ financialStatus: 'PENDING', gateways: ['Cash on Delivery (COD)'], outstandingAmount: 1499 });
  const { article } = buildArticle(order, sampleSettings(), 'ET214330015IN', sanitizeOverrides({ codAmount: 999 }));
  assert.equal(article.codr_cod, '');
  assert.equal(article.value_for_codr_cod, '');
});

test('light orders become documents with document dimensions', () => {
  const { article, errors } = buildArticle(sampleOrder({ totalWeightGrams: 200 }), sampleSettings(), 'ET214330015IN');
  assert.deepEqual(errors, []);
  assert.equal(article.article_type, 'SP_INLAND_DOC');
  assert.equal(article.shape_of_article, 'DOC');
  assert.equal(article.height, '1');
});

test('reports missing data before calling India Post', () => {
  const order = sampleOrder({ shippingAddress: { ...sampleOrder().shippingAddress, zip: '5600', phone: '' } });
  const settings = sampleSettings({ officeId: '' });
  const { errors } = buildArticle(order, settings, 'ET214330015IN');
  assert.ok(errors.some((e) => e.includes('pincode')));
  assert.ok(errors.some((e) => e.includes('mobile')));
  assert.ok(errors.some((e) => e.includes('office id')));
});

test('pickup mode fills pickup fields with a schedule date', () => {
  const settings = sampleSettings({ mode: 'PICKUP' });
  const { article, errors } = buildArticle(sampleOrder(), settings, 'ET214330015IN');
  assert.deepEqual(errors, []);
  assert.equal(article.pickup_address_flag, 'TRUE');
  assert.equal(article.pickup_pincode, '600001');
  assert.match(article.pickup_schedule_date, /^\d{2}\/\d{2}\/\d{4} 10:00:00 AM$/);
});

test('pickup schedule skips Sunday', () => {
  // Saturday 2026-09-26 12:00 IST → next working day is Monday 09/28
  assert.equal(pickupScheduleDate('13:00-16:00', new Date('2026-09-26T06:30:00Z')), '09/28/2026 01:00:00 PM');
});

test('form edits override order data and defaults', () => {
  const overrides = sanitizeOverrides({
    receiver: { name: 'Asha K', phone: '9123456789', zip: '560001', evil: 'x' },
    product: 'BUSINESS_PARCEL',
    weightGrams: '1500.4',
    dimensions: { length: '25', breadth: '20', height: '12' },
    insuranceValue: '0',
    unknown: true,
  });
  assert.deepEqual(Object.keys(overrides.receiver), ['name', 'zip', 'phone']);
  assert.equal(overrides.weightGrams, 1500);
  const { article, errors } = buildArticle(sampleOrder(), sampleSettings({ indiaPost: { ...sampleSettings().indiaPost } }), 'ET214330015IN', overrides);
  assert.deepEqual(errors, []);
  assert.equal(article.article_type, 'BUSINESS_PARCEL');
  assert.equal(article.contract_id, '41367422');
  assert.equal(article.receiver_name, 'Asha K');
  assert.equal(article.receiver_pincode, '560001');
  assert.equal(article.receiver_mobile_no, '9123456789');
  assert.equal(article.receiver_city, 'Bengaluru', 'untouched fields come from the order');
  assert.equal(article.physical_weight, 1500);
  assert.equal(article.height, '12');
  assert.equal(article.insurance_type, '');
});

test('new stores book every order as Parcel & Gyan Post', () => {
  assert.equal(defaultSettings().product, 'PARCEL_GYAN_POST');
  const settings = mergeSettings({ ...sampleSettings(), product: defaultSettings().product });
  const { article, errors } = buildArticle(sampleOrder({ totalWeightGrams: 500 }), settings, 'CL581690681IN', sanitizeOverrides({ dimensions: { length: 15, breadth: 10, height: 5 } }));
  assert.equal(article.article_type, 'PARCEL_GYAN_POST', 'no switch to a document at 500 g');
  assert.equal(article.shape_of_article, 'NROL');
  assert.deepEqual(errors.filter((e) => !/contract id/.test(e)), [], 'small parcels are fine');
});

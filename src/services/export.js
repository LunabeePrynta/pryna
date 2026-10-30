// Excel export of saved India Post shipments.
// Sheet 1 "Orders" is a readable register; sheet 2 "India Post upload" uses the India Post bulk booking
// field names so it can be used for the India Post portal / SFTP bulk upload.

import ExcelJS from 'exceljs';
import { PRODUCTS, addressText, senderFields } from '../indiapost/mapper.js';
import { STATUS_LABELS } from '../indiapost/events.js';

// Column order of the India Post Bulk Booking API / bulk upload file.
export const UPLOAD_FIELDS = [
  'bulk_customer_id', 'contract_id', 'barcode_no', 'pickup_or_dropoff', 'pickup_dropoff_office_id', 'article_type',
  'physical_weight', 'shape_of_article', 'length', 'breadth_diameter', 'height', 'priority_flag', 'delivery_instruction',
  'delivery_slot', 'instruction_rts', 'sender_name', 'sender_company', 'sender_add_line_1', 'sender_add_line_2',
  'sender_add_line_3', 'sender_city', 'sender_state', 'sender_pincode', 'sender_emailid', 'sender_alt_contact',
  'sender_kyc', 'sender_tax_reference', 'receiver_name', 'receiver_company', 'receiver_add_line_1',
  'receiver_add_line_2', 'receiver_add_line_3', 'receiver_city', 'receiver_state', 'receiver_pincode',
  'receiver_emailid', 'receiver_alt_contact', 'receiver_kyc', 'receiver_tax_reference', 'alt_address_flag',
  'pickup_address_flag', 'drop_off_pincode', 'sender_mobile_no', 'receiver_mobile_no', 'prepayment_code',
  'value_of_prepayment', 'codr_cod', 'value_for_codr_cod', 'insurance_type', 'value_of_insurance', 'ack', 'reg', 'otp',
  'bulk_reference', 'pickup_address_id', 'pickup_addressee_name', 'pickup_company_name', 'pickup_address_line1',
  'pickup_address_line2', 'pickup_address_line3', 'pickup_city', 'pickup_state', 'pickup_pincode', 'pickup_email_id',
  'pickup_alt_contact_no', 'pickup_mobile_no', 'pickup_schedule_slot', 'pickup_schedule_date', 'alt_addressee_name',
  'alt_company_name', 'alt_address_line1', 'alt_address_line2', 'alt_address_line3', 'alt_city', 'alt_state',
  'alt_pincode', 'alt_email_id', 'alt_contact_no', 'alt_alternate_mobile_no',
];

const ORDER_COLUMNS = [
  { header: 'Booking date', key: 'date', width: 13 },
  { header: 'Order', key: 'order', width: 10 },
  { header: 'Tracking number', key: 'awb', width: 17 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Customer name', key: 'name', width: 22 },
  { header: 'Mobile', key: 'mobile', width: 13 },
  { header: 'Email', key: 'email', width: 26 },
  { header: 'Address line 1', key: 'a1', width: 32 },
  { header: 'Address line 2', key: 'a2', width: 24 },
  { header: 'Address line 3', key: 'a3', width: 18 },
  { header: 'City', key: 'city', width: 16 },
  { header: 'State', key: 'state', width: 16 },
  { header: 'Pincode', key: 'pincode', width: 9 },
  { header: 'Post office', key: 'postOffice', width: 20 },
  { header: 'Product', key: 'product', width: 18 },
  { header: 'Weight (g)', key: 'weight', width: 10 },
  { header: 'Length (cm)', key: 'length', width: 11 },
  { header: 'Breadth (cm)', key: 'breadth', width: 12 },
  { header: 'Height (cm)', key: 'height', width: 11 },
  { header: 'Insured value', key: 'insurance', width: 12 },
  { header: 'Latest tracking update', key: 'lastEvent', width: 36 },
];

const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * Picks the shipments to export: the ticked ones (`ids`) or, when none are ticked, those in the
 * booking date range (YYYY-MM-DD, India time, inclusive), optionally only those not downloaded before.
 */
export function selectShipments(shipments, { from, to, onlyNew, ids } = {}) {
  // Ticked orders win over the date filters.
  if (ids?.length) {
    const wanted = new Set(ids);
    return shipments.filter((s) => wanted.has(s.id));
  }
  return shipments.filter((s) => {
    const day = istDate(s.booked_at);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (onlyNew && s.exported_at) return false;
    return true;
  });
}

function productLabel(articleType) {
  if (!articleType) return '';
  if (articleType === 'SP_INLAND_DOC') return 'Speed Post (document)';
  if (articleType === 'SP_INLAND_PARCEL') return 'Speed Post (parcel)';
  return PRODUCTS[articleType] ?? articleType;
}

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
}

/** Builds the .xlsx workbook. Returns a Buffer. */
export async function buildWorkbook(shipments) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'India Post Shipping';
  workbook.created = new Date();

  const orders = workbook.addWorksheet('Orders');
  orders.columns = ORDER_COLUMNS;
  for (const s of shipments) {
    const a = s.article ?? {};
    const [y, m, d] = istDate(s.booked_at).split('-');
    orders.addRow({
      date: `${d}-${m}-${y}`,
      order: s.order_name,
      awb: s.barcode,
      status: STATUS_LABELS[s.status] ?? s.status,
      name: a.receiver_name,
      mobile: a.receiver_mobile_no,
      email: a.receiver_emailid,
      a1: a.receiver_add_line_1,
      a2: a.receiver_add_line_2,
      a3: a.receiver_add_line_3,
      city: a.receiver_city,
      state: a.receiver_state,
      pincode: a.receiver_pincode,
      postOffice: a.receiver_post_office ?? '',
      product: productLabel(a.article_type ?? s.article_type),
      weight: a.physical_weight !== undefined ? Number(a.physical_weight) : null,
      length: a.length ? Number(a.length) : null,
      breadth: a.breadth_diameter ? Number(a.breadth_diameter) : null,
      height: a.height ? Number(a.height) : null,
      insurance: Number(a.value_of_insurance) || 0,
      lastEvent: s.last_event ?? '',
    });
  }
  styleHeader(orders);

  const upload = workbook.addWorksheet('India Post upload');
  upload.columns = UPLOAD_FIELDS.map((key) => ({ header: key, key, width: Math.max(12, key.length + 2) }));
  for (const s of shipments) {
    const a = { ...(s.article ?? {}), barcode_no: s.barcode };
    upload.addRow(Object.fromEntries(UPLOAD_FIELDS.map((key) => [key, a[key] ?? ''])));
  }
  styleHeader(upload);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------
// India Post "ArticleDetails" bulk booking file (same columns, order and widths as India Post's template).

const upper = (v) => (v === undefined || v === null || v === '' ? null : String(v).toUpperCase());
const text = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const numberOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
};
const positive = (v) => (Number(v) > 0 ? Number(v) : null);
const flag = (v) => v === 'TRUE' || v === true;

/** [header, column width, value(shipment, article, index)] */
export const ARTICLE_DETAILS_COLUMNS = [
  ['SERIAL NUMBER', 17, (s, a, i) => i + 1],
  ['BARCODE NO', 17, (s) => s.barcode],
  ['PHYSICAL WEIGHT', 21, (s, a) => numberOrNull(a.physical_weight)],
  ['REG', 12.4, (s, a) => flag(a.reg)],
  ['OTP', 12, (s, a) => flag(a.otp)],
  ['RECEIVER CITY', 21.7, (s, a) => upper(a.receiver_city)],
  ['RECEIVER PINCODE', 20.4, (s, a) => numberOrNull(a.receiver_pincode)],
  ['RECEIVER NAME', 22, (s, a) => upper(a.receiver_name)],
  ['RECEIVER ADD LINE 1', 27.3, (s, a) => upper(addressText(a.receiver_add_line_1))],
  ['RECEIVER ADD LINE 2', 28, (s, a) => upper(addressText(a.receiver_add_line_2))],
  ['RECEIVER ADD LINE 3', 30, (s, a) => upper(addressText(a.receiver_add_line_3))],
  ['ACK', 12, (s, a) => flag(a.ack)],
  ['SENDER MOBILE NO', 24.3, (s, a) => numberOrNull(a.sender_mobile_no)],
  ['RECEIVER MOBILE NO', 30, (s, a) => numberOrNull(a.receiver_mobile_no)],
  // Left empty: no prepayment code or amount.
  ['PREPAYMENT CODE', 23, () => null],
  ['VALUE OF PREPAYMENT', 24.7, () => null],
  // All orders are prepaid, so the COD columns stay empty.
  ['CODR/COD', 12, () => null],
  ['VALUE FOR CODR/COD', 17.7, () => null],
  ['INSURANCE TYPE', 18.6, (s, a) => text(a.insurance_type)],
  ['VALUE OF INSURANCE', 22, (s, a) => positive(a.value_of_insurance)],
  ['SHAPE OF ARTICLE', 18, (s, a) => text(a.shape_of_article)],
  ['LENGTH ', 12, (s, a) => numberOrNull(a.length)],
  ['BREADTH/DIAMETER', 18, (s, a) => numberOrNull(a.breadth_diameter)],
  ['HEIGHT', 12, (s, a) => numberOrNull(a.height)],
  ['PRIORITY FLAG', 15, (s, a) => flag(a.priority_flag)],
  ['DELIVERY INSTRUCTION', 22, (s, a) => text(a.delivery_instruction)],
  ['DELIVERY SLOT', 15, (s, a) => text(a.delivery_slot)],
  ['INSTRUCTION RTS', 17, (s, a) => text(a.instruction_rts)],
  ['SENDER NAME', 28, (s, a) => upper(a.sender_name)],
  ['SENDER COMPANY NAME', 21, (s, a) => upper(a.sender_company)],
  ['SENDER CITY', 13, (s, a) => upper(a.sender_city)],
  ['SENDER STATE/UT', 17, (s, a) => upper(a.sender_state)],
  ['SENDER PINCODE', 16, (s, a) => text(a.sender_pincode)],
  ['SENDER EMAILID', 16, (s, a) => text(a.sender_emailid)],
  ['SENDER ALT CONTACT', 20, (s, a) => numberOrNull(a.sender_alt_contact)],
  ['SENDER KYC', 12, (s, a) => text(a.sender_kyc)],
  ['SENDER TAX', 16, (s, a) => text(a.sender_tax_reference)],
  ['RECEIVER COMPANY NAME', 23, (s, a) => upper(a.receiver_company)],
  ['RECEIVER STATE/UT', 19, (s, a) => upper(a.receiver_state)],
  ['RECEIVER EMAILID', 18, (s, a) => text(a.receiver_emailid)],
  ['RECEIVER ALT CONTACT', 22, (s, a) => numberOrNull(a.receiver_alt_contact)],
  ['RECEIVER KYC', 14, (s, a) => text(a.receiver_kyc)],
  ['RECEIVER TAX REF', 18, (s, a) => text(a.receiver_tax_reference)],
  ['ALT ADDRESS FLAG', 18, (s, a) => flag(a.alt_address_flag)],
  // "<ref no>/<serial>" like India Post's booking tool (e.g. 1/1, 1/2); the order number without a ref no.
  ['BULK REFERENCE', 22.3, (s, a, i, ref) => (ref ? `${ref}/${i + 1}` : text(a.bulk_reference) ?? text(s.order_name))],
  // Address lines never contain dots or commas (also for orders saved before this rule).
  // Sender lines as typed in Settings, like India Post's booking tool.
  ['SENDER ADD LINE 1', 20.1, (s, a) => text(addressText(a.sender_add_line_1))],
  ['SENDER ADD LINE 2', 22.6, (s, a) => text(addressText(a.sender_add_line_2))],
  ['SENDER ADD LINE 3', 24.3, (s, a) => text(addressText(a.sender_add_line_3))],
];

/** Builds India Post's ArticleDetails bulk booking workbook. Returns a Buffer. */
export async function buildArticleDetailsWorkbook(shipments, { ref } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'India Post Shipping';
  const sheet = workbook.addWorksheet('ArticleDetails');
  sheet.columns = ARTICLE_DETAILS_COLUMNS.map(([header, width]) => ({ header, width }));
  shipments.forEach((s, i) => {
    const a = s.article ?? {};
    sheet.addRow(ARTICLE_DETAILS_COLUMNS.map(([, , value]) => value(s, a, i, ref)));
  });
  // Bulk reference is text (e.g. "1/1", "461/50"), as in India Post's template.
  sheet.getColumn(ARTICLE_DETAILS_COLUMNS.findIndex(([h]) => h === 'BULK REFERENCE') + 1).numFmt = '@';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export const EXPORT_FORMATS = {
  indiapost: { label: 'India Post booking file (ArticleDetails)', file: 'ArticleDetails', build: buildArticleDetailsWorkbook },
  report: { label: 'Orders report', file: 'india-post-orders', build: buildWorkbook },
};

/** Selects, builds and (optionally) marks shipments as downloaded. */
export async function exportShipments(ctx, shop, { from, to, onlyNew, ids, markExported, format = 'indiapost', ref } = {}) {
  // The sender always comes from the current Settings, also for orders saved before it was filled in.
  const sender = senderFields(ctx.getSettings(shop));
  const shipments = selectShipments(ctx.db.listShipmentsForExport(shop), { from, to, onlyNew, ids }).map((s) => ({
    ...s,
    article: { ...(s.article ?? {}), ...sender },
  }));
  const buffer = await (EXPORT_FORMATS[format] ?? EXPORT_FORMATS.indiapost).build(shipments, { ref });
  if (markExported) ctx.db.markExported(shop, shipments.map((s) => s.id), new Date().toISOString());
  // The next booking file gets the next ref no.
  if (markExported && ref && shipments.length && format !== 'report') ctx.setNextExportRef(shop, ref + 1);
  return { buffer, count: shipments.length };
}

// Excel export of saved India Post shipments.
// Sheet 1 "Orders" is a readable register; sheet 2 "India Post upload" uses the India Post bulk booking
// field names so it can be used for the India Post portal / SFTP bulk upload.

import ExcelJS from 'exceljs';
import { PRODUCTS } from '../indiapost/mapper.js';
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
  { header: 'Product', key: 'product', width: 18 },
  { header: 'Weight (g)', key: 'weight', width: 10 },
  { header: 'Length (cm)', key: 'length', width: 11 },
  { header: 'Breadth (cm)', key: 'breadth', width: 12 },
  { header: 'Height (cm)', key: 'height', width: 11 },
  { header: 'COD amount', key: 'cod', width: 11 },
  { header: 'Insured value', key: 'insurance', width: 12 },
  { header: 'Latest tracking update', key: 'lastEvent', width: 36 },
];

const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * Filters saved shipments by booking date (YYYY-MM-DD, India time, inclusive) and
 * optionally only those not downloaded before.
 */
export function selectShipments(shipments, { from, to, onlyNew } = {}) {
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
      product: productLabel(a.article_type ?? s.article_type),
      weight: a.physical_weight !== undefined ? Number(a.physical_weight) : null,
      length: a.length ? Number(a.length) : null,
      breadth: a.breadth_diameter ? Number(a.breadth_diameter) : null,
      height: a.height ? Number(a.height) : null,
      cod: a.codr_cod === 'COD' ? Number(a.value_for_codr_cod) : 0,
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

/** Selects, builds and (optionally) marks shipments as downloaded. */
export async function exportShipments(ctx, shop, { from, to, onlyNew, markExported } = {}) {
  const shipments = selectShipments(ctx.db.listShipmentsForExport(shop), { from, to, onlyNew });
  const buffer = await buildWorkbook(shipments);
  if (markExported) ctx.db.markExported(shop, shipments.map((s) => s.id), new Date().toISOString());
  return { buffer, count: shipments.length };
}

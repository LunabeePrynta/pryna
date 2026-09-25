// Converts a Shopify order into India Post booking and label payloads, following the
// field rules in the India Post "External Integrations – Approach Document".

export const PRODUCTS = {
  SPEED_POST: 'Speed Post (auto: document ≤ 500 g, parcel above)',
  BUSINESS_PARCEL: 'Business Parcel',
  '24_SPEEDPOST_DOC': '24 hr Speed Post Document',
  '24_SPP_PARSPL': '24 hr Speed Post Parcel Special',
  '48_SPEEDPOST_DOC': '48 hr Speed Post Document',
};

const DOC_TYPES = new Set(['SP_INLAND_DOC', '24_SPEEDPOST_DOC', '48_SPEEDPOST_DOC']);

// Weight in grams, dimensions in cm (min/max) per article type.
const LIMITS = {
  DOC: { weight: [1, 500], length: [1, 42], breadth: [1, 29], height: [1, 2] },
  PARCEL: { weight: [1, 35000], length: [14, 150], breadth: [9, 150], height: [1, 150] },
  PARSPL: { weight: [1, 5000], length: [14, 150], breadth: [9, 150], height: [1, 150] },
};

export function limitsFor(articleType) {
  if (DOC_TYPES.has(articleType)) return LIMITS.DOC;
  if (articleType === '24_SPP_PARSPL') return LIMITS.PARSPL;
  return LIMITS.PARCEL;
}

export function isDocument(articleType) {
  return DOC_TYPES.has(articleType);
}

export function defaultSettings() {
  return {
    indiaPost: {
      username: '',
      password: '',
      bulkCustomerId: '',
      // Contract id per product, issued by India Post.
      contracts: {
        SPEED_POST: '',
        BUSINESS_PARCEL: '',
        '24_SPEEDPOST_DOC': '',
        '24_SPP_PARSPL': '',
        '48_SPEEDPOST_DOC': '',
      },
    },
    // AWB series allotted by India Post, e.g. ET21433001XIN → ET21434000XIN.
    barcode: { seriesStart: '', seriesEnd: '' },
    product: 'SPEED_POST',
    // DROPOFF: you hand articles in at a post office. PICKUP: India Post collects from your address.
    mode: 'DROPOFF',
    officeId: '',
    pickupSlot: '10:00-13:00',
    sender: {
      name: '',
      company: '',
      address1: '',
      address2: '',
      address3: '',
      city: '',
      state: '',
      pincode: '',
      mobile: '',
      email: '',
    },
    package: {
      defaultWeightGrams: 500,
      packagingWeightGrams: 0,
      doc: { length: 30, breadth: 21, height: 1 },
      parcel: { length: 20, breadth: 15, height: 10 },
      parcelShape: 'NROL',
    },
    cod: { enabled: true },
    insurance: { enabled: false, minOrderValue: 5000 },
    label: { size: 'A6', transmissionMode: 'S', bookingOfficeName: '', bookingOfficePin: '' },
    automation: { autoPush: false, autoFulfill: true, notifyCustomer: true },
  };
}

/** Deep-merges saved settings over the defaults so new keys always exist. */
export function mergeSettings(saved) {
  const merge = (base, over) => {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) ? merge(base[k], v) : v;
    }
    return out;
  };
  return merge(defaultSettings(), saved ?? {});
}

export function chooseArticleType(product, weightGrams) {
  if (product === 'SPEED_POST') return weightGrams <= 500 ? 'SP_INLAND_DOC' : 'SP_INLAND_PARCEL';
  return product;
}

function contractKey(articleType) {
  return articleType.startsWith('SP_INLAND_') ? 'SPEED_POST' : articleType;
}

/** Indian mobile numbers only: 10 digits starting with 6-9 (country code / trunk 0 stripped). */
export function normalizeMobile(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export function normalizePincode(value) {
  const digits = String(value ?? '').replace(/\s/g, '');
  return /^[1-9]\d{5}$/.test(digits) ? digits : null;
}

function clip(value, max = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Splits free-form address text into at most three lines of ≤ 80 chars
 * (combined ≤ 240), breaking on word boundaries.
 */
export function splitAddress(...parts) {
  const text = parts.map((p) => clip(p, 240)).filter(Boolean).join(', ').slice(0, 240);
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= 80) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.slice(0, 80);
    }
  }
  if (current) lines.push(current);
  const [l1 = '', l2 = '', ...rest] = lines;
  let l3 = rest.join(' ').slice(0, 80);
  // India Post rejects address lines shorter than 3 characters.
  return [l1, l2.length >= 3 ? l2 : '', l3.length >= 3 ? l3 : ''];
}

function nowInIst(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60_000);
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth() + 1,
    d: ist.getUTCDate(),
    h: ist.getUTCHours(),
    min: ist.getUTCMinutes(),
    s: ist.getUTCSeconds(),
    dow: ist.getUTCDay(),
    ist,
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** Next working day (Mon–Sat) at the slot start, formatted MM/DD/YYYY hh:mm:ss AM/PM. */
export function pickupScheduleDate(slot, date = new Date()) {
  let t = nowInIst(date).ist;
  t = new Date(t.getTime() + 24 * 3600_000);
  if (t.getUTCDay() === 0) t = new Date(t.getTime() + 24 * 3600_000);
  const [hour] = String(slot || '10:00').split(':').map(Number);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}/${t.getUTCFullYear()} ${pad(h12)}:00:00 ${hour < 12 ? 'AM' : 'PM'}`;
}

/** DD-MM-YYYY HH:mm:ss in IST, as used by the label API. */
export function labelDateTime(date = new Date()) {
  const t = nowInIst(date);
  return `${pad(t.d)}-${pad(t.m)}-${t.y} ${pad(t.h)}:${pad(t.min)}:${pad(t.s)}`;
}

function isCashOnDelivery(order) {
  const gateways = (order.gateways ?? []).join(' ');
  const unpaid = ['PENDING', 'PARTIALLY_PAID', 'AUTHORIZED'].includes(order.financialStatus);
  return unpaid && /cash on delivery|\bcod\b/i.test(gateways);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Builds one booking article for the Bulk Booking API.
 * Returns { article, errors } — errors are problems found before calling India Post.
 */
export function buildArticle(order, settings, barcode) {
  const errors = [];
  const ip = settings.indiaPost;
  const pkg = settings.package;

  const weight = Math.max(
    1,
    Math.round((Number(order.totalWeightGrams) || Number(pkg.defaultWeightGrams) || 0) + (Number(pkg.packagingWeightGrams) || 0)),
  );
  const articleType = chooseArticleType(settings.product, weight);
  const doc = isDocument(articleType);
  const dims = doc ? pkg.doc : pkg.parcel;
  const contractId = ip.contracts?.[contractKey(articleType)];

  const address = order.shippingAddress;
  if (!address) errors.push('Order has no shipping address');
  const receiverPincode = normalizePincode(address?.zip);
  if (address && !receiverPincode) errors.push(`Invalid receiver pincode "${address?.zip ?? ''}"`);
  if (address?.countryCode && address.countryCode !== 'IN') errors.push('Only domestic (India) addresses are supported');
  const receiverMobile =
    normalizeMobile(address?.phone) ?? normalizeMobile(order.phone) ?? normalizeMobile(order.customer?.phone);
  if (!receiverMobile) errors.push('Receiver needs a 10 digit Indian mobile number (starting 6–9)');

  const sender = settings.sender;
  const senderPincode = normalizePincode(sender.pincode);
  const senderMobile = normalizeMobile(sender.mobile);
  if (!ip.bulkCustomerId) errors.push('Settings: India Post customer id is missing');
  if (!contractId) errors.push(`Settings: contract id for ${articleType} is missing`);
  if (!settings.officeId || !/^\d{8}$/.test(String(settings.officeId))) errors.push('Settings: pickup/drop-off office id must be 8 digits');
  if (!sender.name || !sender.address1 || !sender.city) errors.push('Settings: sender name, address and city are required');
  if (!senderPincode) errors.push('Settings: sender pincode is invalid');
  if (!senderMobile) errors.push('Settings: sender mobile is invalid');

  const limits = limitsFor(articleType);
  const checkRange = (label, value, [min, max], unit) => {
    if (!(value >= min && value <= max)) errors.push(`${label} ${value}${unit} is outside ${min}–${max}${unit} for ${articleType}`);
  };
  checkRange('Weight', weight, limits.weight, ' g');
  checkRange('Length', Number(dims.length), limits.length, ' cm');
  checkRange('Breadth', Number(dims.breadth), limits.breadth, ' cm');
  checkRange('Height', Number(dims.height), limits.height, ' cm');

  const receiverLines = splitAddress(address?.address1, address?.address2);
  const senderLines = splitAddress(sender.address1, sender.address2, sender.address3);
  if (address && receiverLines[0].length < 3) errors.push('Receiver address line 1 is too short');

  const cod = settings.cod?.enabled && isCashOnDelivery(order);
  const codValue = cod ? round2(order.outstandingAmount || order.totalAmount) : '';
  const insure = settings.insurance?.enabled && Number(order.totalAmount) >= Number(settings.insurance.minOrderValue || 0);
  const pickup = settings.mode === 'PICKUP';
  const otp = articleType === '24_SPP_PARSPL'; // OTP is mandatory for 24_SPP_PARSPL

  const article = {
    bulk_customer_id: String(ip.bulkCustomerId),
    contract_id: String(contractId ?? ''),
    barcode_no: barcode,
    pickup_or_dropoff: pickup ? 'PICKUP' : 'DROPOFF',
    pickup_dropoff_office_id: Number(settings.officeId) || 0,
    article_type: articleType,
    physical_weight: weight,
    shape_of_article: doc ? 'DOC' : pkg.parcelShape || 'NROL',
    length: String(dims.length),
    breadth_diameter: String(dims.breadth),
    height: String(dims.height),
    priority_flag: '',
    delivery_instruction: '',
    delivery_slot: '',
    instruction_rts: '',
    sender_name: clip(sender.name),
    sender_company: clip(sender.company),
    sender_add_line_1: senderLines[0],
    sender_add_line_2: senderLines[1],
    sender_add_line_3: senderLines[2],
    sender_city: clip(sender.city),
    sender_state: clip(sender.state),
    sender_pincode: senderPincode ?? '',
    sender_emailid: clip(sender.email),
    sender_alt_contact: '',
    sender_kyc: '',
    sender_tax_reference: '',
    receiver_name: clip(address?.name),
    receiver_company: clip(address?.company),
    receiver_add_line_1: receiverLines[0],
    receiver_add_line_2: receiverLines[1],
    receiver_add_line_3: receiverLines[2],
    receiver_city: clip(address?.city),
    receiver_state: clip(address?.province),
    receiver_pincode: receiverPincode ?? '',
    receiver_emailid: clip(order.email),
    receiver_alt_contact: '',
    receiver_kyc: '',
    receiver_tax_reference: '',
    alt_address_flag: 'FALSE',
    pickup_address_flag: pickup ? 'TRUE' : 'FALSE',
    drop_off_pincode: pickup ? '' : senderPincode ?? '',
    sender_mobile_no: senderMobile ?? '',
    receiver_mobile_no: receiverMobile ?? '',
    prepayment_code: '',
    value_of_prepayment: 0,
    codr_cod: cod ? 'COD' : '',
    value_for_codr_cod: codValue,
    insurance_type: insure ? 'DOP' : '',
    value_of_insurance: insure ? round2(order.totalAmount) : 0,
    ack: 'FALSE',
    reg: 'FALSE',
    otp: otp ? 'TRUE' : 'FALSE',
    bulk_reference: clip(order.name, 50),
    pickup_address_id: '',
    pickup_addressee_name: pickup ? clip(sender.name) : '',
    pickup_company_name: pickup ? clip(sender.company || sender.name) : '',
    pickup_address_line1: pickup ? senderLines[0] : '',
    pickup_address_line2: pickup ? senderLines[1] : '',
    pickup_address_line3: pickup ? senderLines[2] : '',
    pickup_city: pickup ? clip(sender.city) : '',
    pickup_state: pickup ? clip(sender.state) : '',
    pickup_pincode: pickup ? senderPincode ?? '' : '',
    pickup_email_id: pickup ? clip(sender.email) : '',
    pickup_alt_contact_no: '0',
    pickup_mobile_no: pickup ? senderMobile ?? '' : '0',
    pickup_schedule_slot: pickup ? settings.pickupSlot : '',
    pickup_schedule_date: pickup ? pickupScheduleDate(settings.pickupSlot) : '',
    alt_addressee_name: '',
    alt_company_name: '',
    alt_address_line1: '',
    alt_address_line2: '',
    alt_address_line3: '',
    alt_city: '',
    alt_state: '',
    alt_pincode: '',
    alt_email_id: '',
    alt_contact_no: '0',
    alt_alternate_mobile_no: '',
  };

  return { article, errors };
}

/** Builds a payload item for the Address Label Generation API from a booked article. */
export function buildLabel(article, settings, { tariff, bookingRef, bookedAt } = {}) {
  const service = article.article_type === 'BUSINESS_PARCEL' ? 'BP' : 'SP';
  const weight = Number(article.physical_weight);
  const volumetric = Math.round((Number(article.length) * Number(article.breadth_diameter) * Number(article.height)) / 5);
  return {
    customer_id: Number(article.bulk_customer_id),
    destination_pin: article.receiver_pincode,
    booking_datetime: labelDateTime(bookedAt ? new Date(bookedAt) : new Date()),
    channel_type: 'E',
    user_type: 'R',
    user_id: Number(article.bulk_customer_id),
    barcode_no: article.barcode_no,
    service_type: service,
    booking_type: 'COMMERCIAL',
    article_length: article.length,
    article_breadth: article.breadth_diameter,
    article_height: article.height,
    charged_weight: Math.max(weight, isDocument(article.article_type) ? 0 : volumetric),
    physical_weight: weight,
    volumetric_weight: volumetric,
    insurance_flag: article.insurance_type === 'DOP',
    insurance_value: Number(article.value_of_insurance) || 0,
    recipient_name: article.receiver_name,
    recipient_mobile: article.receiver_mobile_no,
    recipient_addressl1: article.receiver_add_line_1,
    recipient_addressl2: article.receiver_add_line_2,
    recipient_addressl3: article.receiver_add_line_3,
    recipient_city: article.receiver_city,
    recipient_pin: article.receiver_pincode,
    recipient_state: article.receiver_state,
    sender_name: article.sender_name,
    sender_mobile: article.sender_mobile_no,
    sender_addressl1: article.sender_add_line_1,
    sender_addressl2: article.sender_add_line_2,
    sender_addressl3: article.sender_add_line_3,
    sender_city: article.sender_city,
    sender_pin: article.sender_pincode,
    sender_state: article.sender_state,
    transmission_mode: settings.label.transmissionMode || 'S',
    payment_mode: 'CO',
    booking_office_name: settings.label.bookingOfficeName,
    booking_office_pin: String(settings.label.bookingOfficePin || article.sender_pincode),
    size: settings.label.size || 'A6',
    total_amount: Number(tariff) || 0,
    payment_status: 'PC',
    value_added_services: article.codr_cod === 'COD' ? `COD ${article.value_for_codr_cod}` : '',
    identifier: 'Domestic',
    bkg_ref_id: bookingRef ? String(bookingRef) : '',
    priority: false,
    registered_flag: false,
  };
}

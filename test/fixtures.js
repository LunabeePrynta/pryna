import crypto from 'node:crypto';
import { mergeSettings } from '../src/indiapost/mapper.js';

export function sampleSettings(overrides = {}) {
  return mergeSettings({
    indiaPost: {
      username: 'u',
      password: 'p',
      bulkCustomerId: '3000064781',
      contracts: { SPEED_POST: '41585456', BUSINESS_PARCEL: '41367422' },
    },
    barcode: { seriesStart: 'ET21433001XIN', seriesEnd: 'ET21434000XIN' },
    officeId: '21260024',
    sender: {
      name: 'Luna Bee Store',
      company: 'Luna Bee',
      address1: '12 MG Road',
      city: 'Chennai',
      state: 'Tamil Nadu',
      pincode: '600001',
      mobile: '+91 98765 43210',
      email: 'shop@example.com',
    },
    label: { bookingOfficeName: 'Chennai GPO', bookingOfficePin: '600001' },
    ...overrides,
  });
}

export function sampleOrder(overrides = {}) {
  return {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    email: 'asha@example.com',
    phone: null,
    financialStatus: 'PAID',
    gateways: ['razorpay'],
    totalWeightGrams: 800,
    totalAmount: 1499,
    outstandingAmount: 0,
    shippingAddress: {
      name: 'Asha Kumar',
      company: '',
      address1: 'Flat 4B, Green Residency, 2nd Cross',
      address2: 'Indiranagar',
      city: 'Bengaluru',
      province: 'Karnataka',
      zip: '560038',
      phone: '09876501234',
      countryCode: 'IN',
    },
    customer: { id: 'gid://shopify/Customer/55', phone: null },
    fulfillmentOrders: [],
    ...overrides,
  };
}

export function sessionToken(shop, { key = 'key123', secret = 'secret456', exp = Math.floor(Date.now() / 1000) + 60 } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: key, sub: '1', exp, nbf: exp - 120 });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

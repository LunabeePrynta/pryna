'use strict';

// Ekart adapter. Real mode needs Ekart API access; set in env:
//   EKART_API_BASE   e.g. https://api.ekartlogistics.com   (confirm with your Ekart account manager)
//   EKART_API_TOKEN  bearer token issued by Ekart
//   EKART_TRACK_PATH optional, default /v1/track/{id}  (confirm against your Ekart API docs)
// With EKART_MOCK=1 (or no credentials) it returns demo data so the UI can be built/tested.

const STATUS_STEPS = ['Order Placed', 'Shipped', 'In Transit', 'Out for Delivery', 'Delivered'];

function mockTracking(code) {
  const day = 86400000;
  const now = Date.now();
  return {
    status: 'In Transit',
    currentStep: 2,
    expectedDelivery: new Date(now + 2 * day).toISOString(),
    events: [
      { time: new Date(now - 0.2 * day).toISOString(), status: 'In Transit', location: 'Bengaluru Hub', description: 'Shipment arrived at hub' },
      { time: new Date(now - 1 * day).toISOString(), status: 'Shipped', location: 'Chennai', description: 'Shipment picked up' },
      { time: new Date(now - 1.5 * day).toISOString(), status: 'Order Placed', location: '', description: 'Shipment created' },
    ],
    mock: true,
  };
}

// Map whatever Ekart returns into our shape. Adjust field names to the real response.
function mapEkart(data) {
  const raw = data.track || data.data || data;
  const events = (raw.history || raw.events || raw.scans || []).map((e) => ({
    time: e.time || e.date || e.timestamp || e.event_time,
    status: e.status || e.event || '',
    location: e.location || e.city || e.hub || '',
    description: e.description || e.remarks || e.message || '',
  }));
  events.sort((a, b) => new Date(b.time) - new Date(a.time));
  const status = raw.status || raw.current_status || (events[0] && events[0].status) || 'In Transit';
  const s = status.toLowerCase();
  let currentStep = 1;
  if (/deliver/.test(s) && !/out/.test(s)) currentStep = 4;
  else if (/out for/.test(s)) currentStep = 3;
  else if (/transit|hub|arriv|depart/.test(s)) currentStep = 2;
  else if (/creat|placed|manifest/.test(s)) currentStep = 0;
  return {
    status,
    currentStep,
    expectedDelivery: raw.expected_delivery_date || raw.edd || raw.expectedDelivery || null,
    events,
  };
}

async function trackEkart(code, env = process.env, fetchImpl = globalThis.fetch) {
  if (env.EKART_MOCK === '1' || !env.EKART_API_BASE || !env.EKART_API_TOKEN) {
    return { steps: STATUS_STEPS, ...mockTracking(code) };
  }
  const path = (env.EKART_TRACK_PATH || '/v1/track/{id}').replace('{id}', encodeURIComponent(code));
  const res = await fetchImpl(env.EKART_API_BASE.replace(/\/$/, '') + path, {
    headers: { Authorization: `Bearer ${env.EKART_API_TOKEN}`, Accept: 'application/json' },
  });
  if (res.status === 404) {
    const err = new Error('Tracking ID not found'); err.status = 404; throw err;
  }
  if (!res.ok) {
    const err = new Error('Ekart tracking failed'); err.status = 502; throw err;
  }
  return { steps: STATUS_STEPS, ...mapEkart(await res.json()) };
}

module.exports = { trackEkart, mapEkart, STATUS_STEPS };

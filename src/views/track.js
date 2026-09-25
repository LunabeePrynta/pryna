// Customer-facing tracking page. Rendered inside the storefront theme via the app proxy
// (Content-Type: application/liquid) or as a standalone page.

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_TONE = {
  DELIVERED: 'success',
  OUT_FOR_DELIVERY: 'info',
  IN_TRANSIT: 'info',
  BOOKED: 'neutral',
  ON_HOLD: 'warning',
  RETURNED: 'critical',
};

function formatIst(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

const STYLES = `
<style>
  .ipt { --ipt-fg:#1a1a1a; --ipt-muted:#616161; --ipt-line:#e3e3e3; --ipt-bg:#fff; --ipt-accent:#b3261e;
    max-width:720px; margin:32px auto; padding:0 16px; font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ipt-fg); }
  @media (prefers-color-scheme: dark) { .ipt.ipt--standalone { --ipt-fg:#ececec; --ipt-muted:#a8a8a8; --ipt-line:#3a3a3a; --ipt-bg:#1c1c1c; } }
  .ipt h1 { font-size:24px; margin:0 0 4px; }
  .ipt p.ipt-sub { margin:0 0 20px; color:var(--ipt-muted); }
  .ipt form { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:24px; }
  .ipt input[type=text] { flex:1 1 240px; min-width:0; padding:12px 14px; font-size:16px; border:1px solid var(--ipt-line);
    border-radius:8px; text-transform:uppercase; letter-spacing:.04em; background:var(--ipt-bg); color:var(--ipt-fg); }
  .ipt button { padding:12px 20px; font-size:16px; border:0; border-radius:8px; background:var(--ipt-accent); color:#fff; cursor:pointer; }
  .ipt-card { border:1px solid var(--ipt-line); border-radius:12px; padding:20px; background:var(--ipt-bg); }
  .ipt-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; }
  .ipt-awb { font-size:20px; font-weight:600; letter-spacing:.04em; }
  .ipt-badge { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:600; font-size:13px; }
  .ipt-badge.success { background:#cdfed4; color:#014b10; } .ipt-badge.info { background:#e0f0ff; color:#00316a; }
  .ipt-badge.warning { background:#fff1c7; color:#5e4200; } .ipt-badge.critical { background:#fee9e8; color:#8e0b21; }
  .ipt-badge.neutral { background:#ebebeb; color:#303030; }
  .ipt-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:16px 0 8px; }
  .ipt-meta div span { display:block; color:var(--ipt-muted); font-size:13px; }
  .ipt ol { list-style:none; margin:16px 0 0; padding:0; }
  .ipt li { position:relative; padding:0 0 18px 26px; }
  .ipt li::before { content:""; position:absolute; left:5px; top:6px; width:10px; height:10px; border-radius:50%; background:var(--ipt-line); }
  .ipt li::after { content:""; position:absolute; left:9px; top:18px; bottom:0; width:2px; background:var(--ipt-line); }
  .ipt li:last-child::after { display:none; }
  .ipt li:first-child::before { background:var(--ipt-accent); }
  .ipt li strong { display:block; }
  .ipt li small { color:var(--ipt-muted); }
  .ipt-error { padding:14px 16px; border-radius:8px; background:#fee9e8; color:#8e0b21; }
</style>`;

export function renderTrackingContent({ query = '', result = null, formAction, hiddenFields = {}, standalone = false }) {
  const hidden = Object.entries(hiddenFields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');

  let body = '';
  if (result?.error) {
    body = `<div class="ipt-error" role="alert">${esc(result.error)}</div>`;
  } else if (result) {
    const tone = STATUS_TONE[result.status] ?? 'neutral';
    const meta = [
      result.orderName && ['Order', result.orderName],
      result.booking?.bookedAt && ['Booked at', result.booking.bookedAt],
      result.booking?.bookedOn && ['Booked on', formatIst(result.booking.bookedOn)],
      result.booking?.origin && ['From pincode', result.booking.origin],
      result.booking?.destination && ['To pincode', result.booking.destination],
      result.booking?.deliveryOffice && ['Delivery office', result.booking.deliveryOffice],
    ].filter(Boolean);
    const events = result.events.length
      ? `<ol>${result.events
          .map(
            (e) => `<li><strong>${esc(e.description)}</strong>
              <small>${esc(formatIst(e.happenedAt))}${e.office ? ` · ${esc(e.office)}` : ''}${e.remarks ? ` · ${esc(e.remarks)}` : ''}</small></li>`,
          )
          .join('')}</ol>`
      : '<p class="ipt-sub">Your shipment is registered with India Post. Updates appear here once the article is scanned at the post office.</p>';
    body = `<div class="ipt-card">
      <div class="ipt-head"><div><span class="ipt-sub">India Post article</span><div class="ipt-awb">${esc(result.awb)}</div></div>
      <span class="ipt-badge ${tone}">${esc(result.statusLabel)}</span></div>
      ${meta.length ? `<div class="ipt-meta">${meta.map(([k, v]) => `<div><span>${esc(k)}</span>${esc(v)}</div>`).join('')}</div>` : ''}
      ${events}
    </div>`;
  }

  return `${STYLES}
<div class="ipt${standalone ? ' ipt--standalone' : ''}">
  <h1>Track your order</h1>
  <p class="ipt-sub">Enter the India Post article number from your shipping confirmation.</p>
  <form method="get" action="${esc(formAction)}">
    ${hidden}
    <input type="text" name="awb" value="${esc(query)}" placeholder="e.g. EB123456785IN" maxlength="20" autocomplete="off" aria-label="Article number" required>
    <button type="submit">Track</button>
  </form>
  ${body}
</div>`;
}

export function renderStandalonePage(content) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Track Shipment</title>
<style>body{margin:0;background:#fafafa}@media (prefers-color-scheme: dark){body{background:#111}}</style>
</head><body>${content}</body></html>`;
}

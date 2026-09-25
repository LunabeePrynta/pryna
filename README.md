# India Post Shipping — Shopify app

A Shopify app that sends your latest orders to **India Post**, creates the **address label (PDF)**, marks the
order fulfilled with the India Post article number, and keeps **tracking** up to date for you and your customers.

Built on the India Post *External Integrations – Approach Document* (API option). It uses the Access Token,
Pincode Search, Bulk Booking, Address Label, Bulk Tracking and Webhook APIs.

## What it does

| Step | What happens |
| --- | --- |
| 1. Order comes in | The **Orders** tab in Shopify admin lists the latest orders. You can push them by hand (one or many), or turn on *auto-push* so new paid and COD orders are booked straight from the `orders/create` webhook. |
| 2. Book with India Post | The app takes the next article number (AWB) from the series India Post gave you (check digit uses the *weighted modulus 11* rule), builds the booking article (sender, receiver, weight, size, COD, insurance, pickup or drop-off) and calls `POST /process-articles/{customerId}`. If India Post rejects an article, its errors show next to that order. You can fix the problem and press **Retry**, which reuses the same AWB. |
| 3. Label | The app calls `POST /v1/label/create/domestic` and saves the PDF (A6 or A7). **Print labels** gives you one PDF for all the orders you selected. |
| 4. Fulfil in Shopify | The app creates a Shopify fulfillment with tracking company **India Post**, the AWB, and a link to your storefront tracking page. Shopify can email the customer the shipping confirmation. |
| 5. Tracking | Events come in from the India Post **webhook** as they happen, and the app also polls the **bulk tracking API** every 30 min as a fallback. Every status change is sent to Shopify as a fulfillment event (picked up, in transit, out for delivery, delivered or returned). |
| 6. Customer tracking page | Anyone can enter an article number at `https://<your-store>/apps/track` and see its status and full timeline. The page opens inside your theme through the app proxy. |
| 7. Customer profile | The order's status is saved in the `indiapost.tracking` metafield and the customer's in `indiapost.latest_shipment`. The order page in the customer's account also shows the fulfillment, tracking link and delivery status. |

## Project layout

```
src/
  server.js              Express app: admin API, webhooks, app proxy, polling job
  config.js              Environment configuration
  db.js                  SQLite storage (node:sqlite): shops, settings, shipments, tracking events
  indiapost/
    client.js            India Post API client (token cache + 401 retry)
    barcode.js           S10 article number + weighted modulus 11 check digit
    mapper.js            Shopify order → booking article / label payload + validations
    events.js            Tracking/webhook event normalisation → Shopify statuses
  shopify/
    auth.js              Session tokens, token exchange, webhook & app-proxy HMAC, secret encryption
    admin.js             Admin GraphQL (orders, fulfillmentCreate, fulfillmentEventCreate, metafieldsSet)
  services/
    booking.js           Push orders → book → label → fulfil
    tracking.js          Store events, sync Shopify, public lookup, polling
  views/
    admin.html           Embedded admin UI (App Bridge)
    track.js             Customer tracking page
test/                    node:test suites incl. an end-to-end flow with faked Shopify + India Post
shopify.app.toml         Scopes, webhooks, app proxy
```

## Setup

Requirements: Node.js 22.5+ (it uses the built-in `node:sqlite`) and the Shopify CLI.

1. **Create the app** in the Shopify Partner Dashboard, or run `shopify app config link`. Put the client id in
   `shopify.app.toml` and replace `https://your-app.example.com` with the address where you host the app.
2. **Request protected customer data access** (name, address, phone, email) in the Partner Dashboard. Shopify
   hides order addresses from the app without it.
3. Copy `.env.example` to `.env` and fill it in. Generate `ENCRYPTION_KEY` with `openssl rand -hex 32`.
4. Install and run:
   ```bash
   npm install
   npm start          # or: shopify app dev
   npm test
   ```
5. Run `shopify app deploy` to register the scopes, webhooks (`orders/create`, `app/uninstalled`, GDPR topics)
   and the app proxy (`/apps/track`).
6. Open the app in Shopify admin → **Settings** and fill in:
   - India Post username and password, the bulk customer id, and a contract id for each product
     (UAT: customer `3000064781`, Speed Post contract `41585456`, Business Parcel `41367422`, …)
   - AWB series (UAT: `ET21433001XIN` → `ET21434000XIN`)
   - The pickup or drop-off office id. Use **Find offices** to search by pincode. It only lists delivery
     offices and leaves out BPOs, as India Post requires.
   - Sender address, default weight and size, label size, and the booking office name and pincode
   - Then press **Test connection**
7. Add `/apps/track` to your store's navigation menu.
8. For real-time tracking, send India Post your webhook URL
   (`https://<app>/webhooks/indiapost?secret=<INDIAPOST_WEBHOOK_SECRET>`) and your server's static IP for
   whitelisting. If you can, restrict the webhook to their IPs with `INDIAPOST_WEBHOOK_IPS`.

### Going live

Follow India Post's sandbox checklist: token, tariff, booking, label and tracking all tested. Then point
`INDIAPOST_BASE_URL` at the production host India Post gives you, and replace the UAT credentials, contract
ids and AWB series with the production ones.

## Showing tracking in your theme / customer account

Order metafield `indiapost.tracking` (JSON):

```json
{ "awb": "ET214330016IN", "carrier": "India Post", "status": "OUT_FOR_DELIVERY",
  "status_label": "Out for delivery", "last_event": "Taken out for delivery — Indiranagar SO",
  "last_event_at": "2026-09-26T03:30:00.000Z", "order": "#1001",
  "tracking_url": "https://store.myshopify.com/apps/track?awb=ET214330016IN" }
```

The customer metafield `indiapost.latest_shipment` holds the same data for their most recent shipment. In
Liquid, use `{{ order.metafields.indiapost.tracking.value.status_label }}`. On new customer accounts, show it
with a customer-account UI extension.

## Booking rules applied (from the India Post document)

- Speed Post: articles of 500 g or less are booked as `SP_INLAND_DOC` (shape `DOC`), heavier ones as
  `SP_INLAND_PARCEL`. Weight is sent as a whole number of grams.
- Weight and size limits are checked per product before calling India Post. Documents: 1–500 g,
  42 × 29 × 2 cm. Parcels: up to 35 kg, 14–150 / 9–150 / 1–150 cm. 24_SPP_PARSPL: up to 5 kg.
- Mobile numbers must be 10 digits starting with 6–9. `+91` and a leading `0` are removed automatically.
- Address lines are split into three lines of at most 80 characters, 240 in total. Lines shorter than 3
  characters are dropped.
- Unpaid *Cash on Delivery* orders are booked with `codr_cod = COD` and the amount still owed. Insurance
  (`DOP`) is optional and applies above an order value you choose.
- OTP is always on for `24_SPP_PARSPL`. Pickup mode fills in the pickup address and books the slot on the
  next working day (`MM/DD/YYYY hh:mm:ss AM/PM`).
- India Post tracking times are IST, even though the tracking API marks them with `Z`. The app reads them as
  +05:30.

# India Post Shipping — Shopify app

A Shopify app for shipping orders with **India Post** by hand. You book the parcel with India Post yourself (at
the post office or on the India Post portal) and type its **tracking (article) number** into the app. The app then:

- saves the tracking number, the booking date and the parcel details (address, weight, size, COD)
- marks the Shopify order **fulfilled** with the tracking number, so the customer gets the shipping email and
  sees the tracking on their order and in their account
- lets you **download all created orders as an Excel sheet**, filtered by date

The app does **not** send anything to India Post automatically. Live tracking updates are optional: they work
only if you add India Post API login details in Settings.

## Using it in Shopify admin

Open **Apps → India Post Shipping**.

### Orders tab: add tracking numbers

The list shows orders still waiting for a tracking number.

- **Quick entry:** type the tracking number in the order's row and press **Enter**. To save several at once,
  fill in the rows and click **Save N tracking numbers**. They are saved with the **Booking date** at the top.
- **Create order:** opens a form for one order. It has the tracking number and booking date, plus the
  receiver's name, mobile and address, the product, weight and size, and the COD and insured amounts. All of
  these are filled in from the Shopify order and can be edited. **Create order & fulfil** saves everything and
  fulfils the order.
- **Edit:** fixes a saved order, e.g. a wrong tracking number. The new number replaces the old one on the
  Shopify fulfilment; no second fulfilment is created.

Tracking numbers are checked as you type. The format must be 2 letters, 9 digits, 2 letters (e.g.
`EB123456785IN`), and India Post's check digit catches most typos. A number can't be used on two orders.
Problems such as a missing mobile number or a weight outside India Post's limits show as yellow warnings.
They don't stop you saving.

### Created orders & Excel tab

This tab lists every order that has a tracking number. Filter by **From / To** booking date, or tick **Only not
downloaded yet**, then click **Download Excel**. The file has two sheets:

| Sheet | Contents |
| --- | --- |
| **Orders** | Booking date, order number, tracking number, status, customer name, mobile, email, address, city, state, pincode, product, weight, size, COD amount, insured value, latest tracking update |
| **India Post upload** | The same orders in India Post's bulk booking column format (`bulk_customer_id`, `contract_id`, `barcode_no`, sender and receiver fields, …), for the India Post portal or SFTP upload |

Downloaded orders are marked with the download date, so **Only not downloaded yet** gives you just the new ones
next time.

### From Shopify's own order pages

| Where | What it does |
| --- | --- |
| Order page → *More actions* → **Add India Post tracking** | Opens the app on that order's form. |
| Orders list → select orders → *More actions* → **Add India Post tracking** | Opens the app with only those orders listed. |

### Settings

- **Shipping defaults:** product, default and packaging weight, document and parcel sizes, COD, insurance, and
  whether to email the customer.
- **Sender address:** used in the Excel upload sheet.
- **India Post account (optional):**
  - Customer and contract ids and post office id fill the upload sheet.
  - The API username and password turn on **live tracking**. With them, the app checks India Post every 30
    minutes and also accepts India Post's webhook. It sends each status (in transit, out for delivery,
    delivered) to the Shopify order. The customer's tracking link then opens your store's own page,
    `https://<store>/apps/track`. Without them, Shopify's standard India Post tracking link is used.

## Project layout

```
src/
  server.js              Express app: admin API, Excel export, webhooks, app proxy, polling job
  config.js              Environment configuration
  db.js                  SQLite storage (node:sqlite): shops, settings, shipments, tracking events
  indiapost/
    barcode.js           India Post article number format + weighted modulus 11 check digit
    mapper.js            Shopify order → India Post shipment fields + validations
    client.js            India Post API client for optional live tracking (token cache + 401 retry)
    events.js            Tracking/webhook event normalisation → Shopify statuses
  shopify/
    auth.js              Session tokens, token exchange, webhook & app-proxy HMAC, secret encryption
    admin.js             Admin GraphQL (orders, fulfillmentCreate, fulfillmentTrackingInfoUpdate, events, metafields)
  services/
    shipments.js         Save tracking number → Shopify fulfilment (create / correct)
    export.js            Excel workbook (Orders + India Post upload sheets)
    tracking.js          Optional live tracking: store events, sync Shopify, public lookup, polling
  views/
    admin.html           Embedded admin UI (App Bridge): orders, create-order form, Excel, settings
    track.js             Customer tracking page
extensions/
  create-shipment-link/  Order page "More actions" link → create-order form
  book-orders-link/      Orders list bulk action → selected orders
deploy/                  One-command Ubuntu/DigitalOcean setup (see deploy/DEPLOY.md)
test/                    node:test suites incl. end-to-end flows with faked Shopify + India Post
shopify.app.toml         Scopes, webhooks, app proxy
```

## Setup

> **Hosting on DigitalOcean (or any Ubuntu 24.04 server):** follow [`deploy/DEPLOY.md`](deploy/DEPLOY.md). The
> `deploy/setup.sh` script installs everything on the server with one command.

Requirements: Node.js 22.5+ (it uses the built-in `node:sqlite`) and the Shopify CLI.

1. **Create the app** in the Shopify Partner Dashboard. Put the client id in `shopify.app.toml`, and set the
   app's URL there (currently `https://ship.lunabee.in`).
2. Set **Distribution → Custom distribution** for your store.
3. On the server, put the Shopify API key and secret in `/etc/indiapost-app.env` (or `.env` locally).
4. Run `shopify app deploy` from your computer, then install the app with the install link from the
   Distribution page.
5. Open the app and fill in **Settings**.

Local development:

```bash
npm install
npm test
npm start          # or: shopify app dev
```

## Updating the app on the server

Upload the new zip to the server and run the setup script again:

```bash
cd /root && unzip -o indiapost-shopify-app.zip && cd indiapost-shopify-app
sudo bash deploy/setup.sh ship.lunabee.in
```

Settings, saved orders and tracking history are kept. The database is updated automatically when the app starts.

## Tracking data in your theme

Order metafield `indiapost.tracking` (JSON) and customer metafield `indiapost.latest_shipment`:

```json
{ "awb": "EB123456785IN", "carrier": "India Post", "status": "IN_TRANSIT",
  "status_label": "In transit", "last_event": "Bag Dispatch — Chennai NSH",
  "last_event_at": "2026-09-26T15:30:00.000Z", "order": "#1001", "tracking_url": null }
```

In Liquid: `{{ order.metafields.indiapost.tracking.value.status_label }}`.

## India Post rules used for the parcel details

- **Speed Post product:** articles of 500 g or less are documents (`SP_INLAND_DOC`, shape `DOC`); heavier
  ones are parcels (`SP_INLAND_PARCEL`).
- **Weight and size limits:**
  - Documents: 1–500 g, 42 × 29 × 2 cm
  - Parcels: up to 35 kg, 14–150 × 9–150 × 1–150 cm
  - 24 hr Parcel Special: up to 5 kg
- **Mobile numbers:** 10 digits starting with 6–9. `+91` and a leading `0` are removed.
- **Addresses:** split into up to three lines of at most 80 characters each.
- **COD:** unpaid Cash-on-Delivery orders get the amount still owed as the COD value.
- **Time zone:** India Post tracking times are read as IST (+05:30).

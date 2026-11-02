# LunaBee parcel tracking (India Post + Ekart)

- `shopify/sections/lunabee-track-code.liquid` – theme section: customer enters a code.
  - India Post code (`EE123456789IN`) -> "This is an India Post parcel" + link to India Post.
  - Ekart code -> calls the tracking API and shows status, expected delivery date, progress steps, full history.
- `shopify/templates-page.track-parcel.json` – install as `templates/page.track-parcel.json`.
- `api/track.js`, `lib/` – backend (Vercel/Netlify style) that detects the carrier and talks to Ekart,
  keeping the Ekart token off the storefront.

## Install
1. Duplicate the live theme (Online Store > Themes > ... > Duplicate).
2. In the copy, add the section file to `sections/` and the template to `templates/page.track-parcel.json`.
3. Deploy this repo's `api/` + `lib/` (e.g. Vercel). Env vars: `EKART_API_BASE`, `EKART_API_TOKEN`,
   optional `EKART_TRACK_PATH`, `EKART_PREFIXES`. Without them it returns demo data (`EKART_MOCK=1` forces it).
4. In the theme editor, paste the deployed URL (`https://<host>/api/track`) into "Tracking API URL".
   Add CORS for `lunabee.in` if hosting elsewhere (or use a Shopify App Proxy).
5. Create a Shopify page using the `track-parcel` template, preview, then publish the theme.

Note: the Ekart response field names in `lib/ekart.js` (`mapEkart`) must be checked against your Ekart API docs.

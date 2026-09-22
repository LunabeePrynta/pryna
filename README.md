# Lyra Kids — Atelier

A bespoke Shopify Online Store 2.0 theme for **lyrakids.in**, built from scratch with
Tailwind CSS v4 and GSAP. No Dawn/Horizon inheritance — every section is purpose-built
for the brand's editorial, luxury feel.

## Stack

| Concern | Choice |
|---|---|
| Styling | Tailwind CSS v4 (CSS-first `@theme`), precompiled to `theme/assets/app.css` |
| Motion | GSAP 3 + ScrollTrigger, vendored into `theme/assets` (no CDN dependency) |
| Type | Cormorant Garamond (display) + Jost (UI), via Google Fonts |
| Templates | OS 2.0 JSON templates + section groups |

## Design tokens

Defined once in `src/styles/app.css` under `@theme`, and overridable per-store from the
theme editor (Theme settings → Colors), which rewrites the same CSS variables at runtime.

| Token | Hex | Role |
|---|---|---|
| `paper` | `#FAF5EC` | page background |
| `ink` | `#2E1A1D` | body text |
| `plum` | `#4A2429` | headings, dark sections |
| `amber` | `#C97B2C` | accent, eyebrows |
| `gold` | `#E7B24A` | highlights on dark |
| `cream` | `#FDF3CD` | text on dark |
| `sand` / `clay` | `#EFE7DA` / `#E7DCCB` | tiles, placeholders |

## Commands

```bash
npm install
npm run build      # compile Tailwind + vendor GSAP
npm run watch:css  # rebuild CSS on change while developing
npm run zip        # package theme/ into lyra-kids-atelier.zip for admin upload
```

**Tailwind scans `theme/**/*.liquid`.** Any new class used in Liquid needs `npm run build:css`
before it exists in the stylesheet — this is the one tradeoff of precompiling.

## Deploying

Either upload `lyra-kids-atelier.zip` in **Online Store → Themes → Add theme → Upload zip**,
or push the `theme/` directory with the Shopify CLI:

```bash
shopify theme push --path theme --unpublished
```

## Homepage sections

`hero` · `marquee` · `shop-by-age` · `wardrobe` · `new-arrivals` · `featured-collection`
`craft` · `press` · `testimonials` · `instagram` · `newsletter` · `footer`

Every section is preset-enabled, so they can be added, reordered and removed in the
theme editor. Images fall back to labelled placeholder tiles, so the page looks
intentional before any photography is uploaded.

## Motion

`theme/assets/app.js` wires GSAP ScrollTrigger to `data-anim` attributes:

- `data-anim="fade-up"` — element rises and fades in
- `data-anim="stagger"` — children animate in sequence
- `data-anim="reveal"` — clip-path wipe, used on imagery
- `data-parallax="12"` — scrub-linked parallax

If GSAP fails to load, or the visitor has *prefers-reduced-motion* set, the
`gsap-ready` class is never applied and everything renders in its final state.

## Status

- [x] Foundation: layout, design system, header, footer, announcement, newsletter
- [x] Homepage: all sections from the brand artwork
- [x] Supporting templates: product, collection, cart, page, blog, article, search, 404
- [ ] Phase 2: collection filters (left sidebar), richer PDP, cart drawer, predictive search

/**
 * Renders a rough static preview of the homepage from the real section files,
 * so the compiled CSS and layout can be eyeballed before the theme is uploaded.
 * It is a smoke test, not a Liquid engine — enough to catch broken layout.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = (p) => resolve(root, 'theme', p);

const order = ['hero','marquee','shop-by-age','wardrobe','new-arrivals','featured-collection','craft','press','testimonials','instagram'];

const settingsGlobal = {
  logo_word: 'Lyra', logo_sub: 'Kids', social_instagram: '@lyrakids',
  contact_email: 'hello@lyrakids.in'
};

function parseSchema(src) {
  const m = src.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch { return {}; }
}
function defaults(schema) {
  const d = {};
  (schema.settings || []).forEach(s => { if (s.id && 'default' in s) d[s.id] = s.default; });
  return d;
}
function presetBlocks(schema) {
  const p = (schema.presets || [])[0];
  if (p && p.blocks) return p.blocks;
  // fall back: one of each declared block type using its defaults
  return (schema.blocks || []).map(b => ({ type: b.type, settings: defaults({ settings: b.settings }) }));
}
function blockDefaults(schema, type) {
  const b = (schema.blocks || []).find(x => x.type === type);
  return b ? defaults({ settings: b.settings }) : {};
}

function mediaTag(args) {
  const label = args.label || 'Image';
  const ratio = args.ratio ? `aspect-ratio:${args.ratio};` : 'min-height:320px;';
  const tone = args.tone === 'plum' ? 'background:#4A2429;color:rgba(253,243,205,.45)'
            : args.tone === 'clay' ? 'background:#E7DCCB;color:rgba(74,36,41,.45)'
            : 'background:#EFE7DA;color:rgba(74,36,41,.45)';
  const cls = args.class || '';
  return `<div class="relative overflow-hidden ${cls}" style="${ratio}">
    <div class="absolute inset-0 grid place-items-center" style="${tone}">
      <span class="text-[10px] tracking-widest2 uppercase">${label}</span></div></div>`;
}

function renderSection(name) {
  let src = readFileSync(T(`sections/${name}.liquid`), 'utf8');
  const schema = parseSchema(src);
  const s = { ...defaults(schema) };
  const css = (src.match(/\{%\s*stylesheet\s*%\}([\s\S]*?)\{%\s*endstylesheet\s*%\}/) || [,''])[1];

  src = src.replace(/\{%\s*schema\s*%\}[\s\S]*?\{%\s*endschema\s*%\}/g, '')
           .replace(/\{%\s*stylesheet\s*%\}[\s\S]*?\{%\s*endstylesheet\s*%\}/g, '')
           .replace(/\{%-?\s*liquid[\s\S]*?-?%\}/g, '')
           .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '');

  // {% render 'media', a: b, ... %}
  src = src.replace(/\{%\s*render\s+'media'([^%]*)%\}/g, (_, argstr) => {
    const args = {};
    argstr.replace(/(\w+):\s*(?:'([^']*)'|([\w.\[\]]+))/g, (_m, k, q, v) => {
      args[k] = q !== undefined ? q : (s[(v||'').replace(/^s\./,'').replace(/^section\.settings\./,'')] ?? v);
      return '';
    });
    return mediaTag(args);
  });
  src = src.replace(/\{%\s*render\s+'price'[^%]*%\}/g, '<span class="mt-1.5 block text-[13px] text-plum/80">₹4,200</span>');
  src = src.replace(/\{%\s*render\s+'product-card'[^%]*%\}/g, '');

  // block loops -> expand from presets
  src = src.replace(/\{%-?\s*for block in section\.blocks\s*-?%\}([\s\S]*?)\{%-?\s*endfor\s*-?%\}/g, (_, body) => {
    return presetBlocks(schema).map(b => {
      const bs = { ...blockDefaults(schema, b.type), ...(b.settings || {}) };
      let out = body;
      out = out.replace(/\{\{\s*block\.settings\.(\w+)[^}]*\}\}/g, (_m, k) => bs[k] ?? '');
      out = out.replace(/\{%\s*render\s+'media'([^%]*)%\}/g, (_m, argstr) => {
        const args = {};
        argstr.replace(/(\w+):\s*(?:'([^']*)'|([\w.\[\]]+))/g, (_x, k, q, v) => {
          const key = (v||'').replace(/^block\.settings\./,'');
          args[k] = q !== undefined ? q : (bs[key] ?? '');
          return '';
        });
        if (!args.label) args.label = bs.placeholder || bs.title || 'Image';
        return mediaTag(args);
      });
      out = out.replace(/\{\{\s*block\.shopify_attributes\s*\}\}/g, '');
      // star rating loop
      out = out.replace(/\{%-?\s*for i in \(1\.\.block\.settings\.rating\)\s*-?%\}([\s\S]*?)\{%-?\s*endfor\s*-?%\}/g,
        (_m, star) => star.repeat(bs.rating || 5));
      return out;
    }).join('\n');
  });

  // simple numeric range loop e.g. (1..2) / (1..4)
  src = src.replace(/\{%-?\s*for \w+ in \((\d+)\.\.(\d+)\)\s*-?%\}([\s\S]*?)\{%-?\s*endfor\s*-?%\}/g,
    (_, a, b, body) => body.repeat(Math.max(0, (+b) - (+a) + 1)));

  // split-list marquee items
  src = src.replace(/\{%-?\s*for item in items\s*-?%\}([\s\S]*?)\{%-?\s*endfor\s*-?%\}/g, (_, body) =>
    String(s.items || '').split(',').map(x => body.replace(/\{\{\s*item[^}]*\}\}/g, x.trim())).join(''));

  // products loop -> empty-state branch
  src = src.replace(/\{%-?\s*if products\.size > 0\s*-?%\}[\s\S]*?\{%-?\s*else\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}/g, (_, els) => els);

  // settings + remaining conditionals
  src = src.replace(/\{\{\s*(?:s|section\.settings)\.(\w+)[^}]*\}\}/g, (_m, k) => s[k] ?? '');
  src = src.replace(/\{\{\s*settings\.(\w+)[^}]*\}\}/g, (_m, k) => settingsGlobal[k] ?? '');
  src = src.replace(/\{\{\s*'now'[^}]*\}\}/g, '2026');
  src = src.replace(/\{%-?\s*(if|unless|else|elsif|endif|endunless|endfor|for|assign|liquid|form|endform|paginate|endpaginate)[\s\S]*?-?%\}/g, '');
  src = src.replace(/\{\{[^}]*\}\}/g, '');

  return { html: src, css };
}

let body = '', extraCss = '';
for (const n of order) {
  const r = renderSection(n);
  body += `\n<!-- ${n} -->\n` + r.html;
  extraCss += r.css + '\n';
}
const header = renderSection('header');
const footer = renderSection('footer');
const news = renderSection('newsletter');

const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Jost:wght@300;400;500&display=swap">
<link rel="stylesheet" href="app.css">
<style>${extraCss}${header.css}${footer.css}</style>
</head><body class="bg-paper text-ink">
${header.html}
<main>${body}\n${news.html}</main>
${footer.html}
</body></html>`;

writeFileSync(resolve(root, 'theme/assets/_preview.html'), page);
console.log('preview written, bytes', page.length);

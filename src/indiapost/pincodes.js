// Post offices for an Indian pincode: the live public directory (api.postalpincode.in) first, then the
// India Post pincode directory bundled with the app (pincodes.tsv.gz), so lookups also work offline.

import fs from 'node:fs';
import zlib from 'node:zlib';

const BUNDLED_FILE = new URL('./pincodes.tsv.gz', import.meta.url);
const LIVE_URL = 'https://api.postalpincode.in/pincode/';
const BRANCH_SUFFIX = { 'Head Post Office': 'HO', 'Sub Post Office': 'SO', 'Branch Post Office': 'BO' };
const TYPE_ORDER = { HO: 0, SO: 1, BO: 2 };
const CACHE_LIMIT = 5000;

let bundled;

/** "Edathala S.O" → "Edathala SO", "Hyderabad G.P.O." → "Hyderabad GPO". */
export function officeName(name) {
  return String(name ?? '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function officeType(name) {
  const m = /\b(GPO|HO|SO|BO)\b/.exec(name);
  return m ? (m[1] === 'GPO' ? 'HO' : m[1]) : '';
}

function sortOffices(offices) {
  const rank = (o) => TYPE_ORDER[o.type] ?? 3;
  return offices.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function bundledDirectory() {
  if (!bundled) {
    bundled = new Map();
    const text = zlib.gunzipSync(fs.readFileSync(BUNDLED_FILE)).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const [pin, office, district, state] = line.split('\t');
      const name = officeName(office);
      if (!bundled.has(pin)) bundled.set(pin, []);
      bundled.get(pin).push({ name, type: officeType(name), district, state });
    }
  }
  return bundled;
}

/** Offices from the bundled India Post directory. */
export function bundledOffices(pincode) {
  return sortOffices([...(bundledDirectory().get(String(pincode)) ?? [])].map((o) => ({ ...o })));
}

/** Offices from api.postalpincode.in's response. */
export function liveOffices(body) {
  const list = Array.isArray(body) ? body[0]?.PostOffice : null;
  if (!Array.isArray(list)) return [];
  return sortOffices(
    list.map((p) => {
      const type = BRANCH_SUFFIX[p.BranchType] ?? '';
      return {
        name: officeName(type && !new RegExp(`\\b${type}$`).test(p.Name) ? `${p.Name} ${type}` : p.Name),
        type,
        district: String(p.District ?? ''),
        state: String(p.State ?? '').toUpperCase(),
      };
    }),
  );
}

export function createPincodeLookup({ fetchImpl = fetch, logger = console, live = true, timeoutMs = 4000 } = {}) {
  const cache = new Map();
  return {
    /** { pincode, offices: [{ name, type, district, state }], source: 'live' | 'bundled' | 'none' } */
    async lookup(pincode) {
      const pin = String(pincode ?? '').trim();
      if (!/^[1-9]\d{5}$/.test(pin)) return { pincode: pin, offices: [], source: 'none' };
      if (cache.has(pin)) return cache.get(pin);
      let result;
      if (live) {
        try {
          const res = await fetchImpl(LIVE_URL + pin, { signal: AbortSignal.timeout(timeoutMs) });
          const offices = res.ok ? liveOffices(await res.json()) : [];
          if (offices.length) result = { pincode: pin, offices, source: 'live' };
        } catch (err) {
          logger.warn?.(`[pincode] live lookup ${pin} failed: ${err.message}`);
        }
      }
      if (!result) {
        const offices = bundledOffices(pin);
        result = { pincode: pin, offices, source: offices.length ? 'bundled' : 'none' };
      }
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(pin, result);
      return result;
    },
  };
}

/**
 * The office a customer's address most likely belongs to: one whose name appears in the address,
 * otherwise the first head / sub office.
 */
export function guessOffice(offices, addressText) {
  if (!offices?.length) return null;
  const text = ` ${String(addressText ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
  const base = (o) => o.name.toUpperCase().replace(/\(.*?\)/g, '').replace(/\b(GPO|HO|SO|BO|NORTH|SOUTH|EAST|WEST)\b/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
  const matches = offices.filter((o) => base(o) && text.includes(` ${base(o)} `));
  return matches.sort((a, b) => base(b).length - base(a).length)[0] ?? offices[0];
}

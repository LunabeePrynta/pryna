import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  shop TEXT PRIMARY KEY,
  access_token TEXT,
  scope TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  uninstalled_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  shop TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Next serial number to use from the India Post AWB series allotted to the shop.
CREATE TABLE IF NOT EXISTS barcode_counters (
  shop TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_serial INTEGER NOT NULL,
  PRIMARY KEY (shop, prefix)
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_name TEXT,
  customer_id TEXT,
  barcode TEXT NOT NULL,
  article_type TEXT,
  article TEXT,
  status TEXT NOT NULL,
  errors TEXT,
  tariff REAL,
  booking_ref TEXT,
  booked_at TEXT,
  label_path TEXT,
  fulfillment_ids TEXT,
  shopify_status TEXT,
  last_event TEXT,
  last_event_at TEXT,
  last_polled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (shop, order_id),
  UNIQUE (shop, barcode)
);
CREATE INDEX IF NOT EXISTS shipments_barcode ON shipments (barcode);
CREATE INDEX IF NOT EXISTS shipments_status ON shipments (shop, status);

CREATE TABLE IF NOT EXISTS tracking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL UNIQUE,
  code TEXT,
  description TEXT,
  office TEXT,
  office_id TEXT,
  remarks TEXT,
  happened_at TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tracking_events_shipment ON tracking_events (shipment_id, happened_at);
`;

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return createStore(db);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateShipment(row) {
  if (!row) return null;
  return {
    ...row,
    errors: parseJson(row.errors, []),
    fulfillment_ids: parseJson(row.fulfillment_ids, []),
    article: parseJson(row.article, null),
  };
}

function createStore(db) {
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    raw: db,
    transaction,

    // ---- shops ----
    saveShop(shop, accessToken, scope) {
      db.prepare(
        `INSERT INTO shops (shop, access_token, scope) VALUES (?, ?, ?)
         ON CONFLICT(shop) DO UPDATE SET access_token = excluded.access_token, scope = excluded.scope,
           uninstalled_at = NULL`,
      ).run(shop, accessToken, scope ?? null);
    },
    getShop(shop) {
      return db.prepare('SELECT * FROM shops WHERE shop = ? AND uninstalled_at IS NULL').get(shop) ?? null;
    },
    markUninstalled(shop) {
      db.prepare(`UPDATE shops SET access_token = NULL, uninstalled_at = datetime('now') WHERE shop = ?`).run(shop);
    },
    listActiveShops() {
      return db.prepare('SELECT shop FROM shops WHERE uninstalled_at IS NULL AND access_token IS NOT NULL').all().map((r) => r.shop);
    },
    deleteShopData(shop) {
      transaction(() => {
        db.prepare('DELETE FROM tracking_events WHERE shipment_id IN (SELECT id FROM shipments WHERE shop = ?)').run(shop);
        db.prepare('DELETE FROM shipments WHERE shop = ?').run(shop);
        db.prepare('DELETE FROM barcode_counters WHERE shop = ?').run(shop);
        db.prepare('DELETE FROM settings WHERE shop = ?').run(shop);
        db.prepare('DELETE FROM shops WHERE shop = ?').run(shop);
      });
    },

    // ---- settings ----
    getSettingsRaw(shop) {
      const row = db.prepare('SELECT data FROM settings WHERE shop = ?').get(shop);
      return row ? parseJson(row.data, {}) : null;
    },
    saveSettingsRaw(shop, data) {
      db.prepare(
        `INSERT INTO settings (shop, data) VALUES (?, ?)
         ON CONFLICT(shop) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
      ).run(shop, JSON.stringify(data));
    },

    // ---- barcode series ----
    /**
     * Atomically reserves the next serial in [start, end] for the prefix.
     * Returns null once the allotted series is exhausted.
     */
    reserveSerial(shop, prefix, start, end) {
      return transaction(() => {
        const row = db.prepare('SELECT next_serial FROM barcode_counters WHERE shop = ? AND prefix = ?').get(shop, prefix);
        const serial = row ? Math.max(row.next_serial, start) : start;
        if (serial > end) return null;
        db.prepare(
          `INSERT INTO barcode_counters (shop, prefix, next_serial) VALUES (?, ?, ?)
           ON CONFLICT(shop, prefix) DO UPDATE SET next_serial = excluded.next_serial`,
        ).run(shop, prefix, serial + 1);
        return serial;
      });
    },
    peekSerial(shop, prefix) {
      return db.prepare('SELECT next_serial FROM barcode_counters WHERE shop = ? AND prefix = ?').get(shop, prefix)?.next_serial ?? null;
    },

    // ---- shipments ----
    createShipment({ shop, orderId, orderName, customerId, barcode, articleType, status }) {
      const info = db
        .prepare(
          `INSERT INTO shipments (shop, order_id, order_name, customer_id, barcode, article_type, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(shop, orderId, orderName ?? null, customerId ?? null, barcode, articleType ?? null, status);
      return this.getShipment(shop, Number(info.lastInsertRowid));
    },
    updateShipment(id, fields) {
      const allowed = [
        'order_name', 'customer_id', 'article_type', 'article', 'status', 'errors', 'tariff', 'booking_ref', 'booked_at',
        'label_path', 'fulfillment_ids', 'shopify_status', 'last_event', 'last_event_at', 'last_polled_at',
      ];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      const values = keys.map((k) => {
        const v = fields[k];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v ?? null;
      });
      db.prepare(
        `UPDATE shipments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ).run(...values, id);
    },
    getShipment(shop, id) {
      return hydrateShipment(db.prepare('SELECT * FROM shipments WHERE shop = ? AND id = ?').get(shop, id));
    },
    getShipmentByOrder(shop, orderId) {
      return hydrateShipment(db.prepare('SELECT * FROM shipments WHERE shop = ? AND order_id = ?').get(shop, orderId));
    },
    getShipmentByBarcode(shop, barcode) {
      return hydrateShipment(db.prepare('SELECT * FROM shipments WHERE shop = ? AND barcode = ?').get(shop, barcode));
    },
    findShipmentsByBarcode(barcode) {
      return db.prepare('SELECT * FROM shipments WHERE barcode = ?').all(barcode).map(hydrateShipment);
    },
    getShipmentByOrderName(shop, orderName) {
      return hydrateShipment(db.prepare('SELECT * FROM shipments WHERE shop = ? AND order_name = ?').get(shop, orderName));
    },
    listShipmentsForOrders(shop, orderIds) {
      if (!orderIds.length) return [];
      const placeholders = orderIds.map(() => '?').join(',');
      return db
        .prepare(`SELECT * FROM shipments WHERE shop = ? AND order_id IN (${placeholders})`)
        .all(shop, ...orderIds)
        .map(hydrateShipment);
    },
    listShipmentsByIds(shop, ids) {
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(',');
      return db
        .prepare(`SELECT * FROM shipments WHERE shop = ? AND id IN (${placeholders}) ORDER BY id`)
        .all(shop, ...ids)
        .map(hydrateShipment);
    },
    listShipments(shop, { limit = 100 } = {}) {
      return db.prepare('SELECT * FROM shipments WHERE shop = ? ORDER BY id DESC LIMIT ?').all(shop, limit).map(hydrateShipment);
    },
    /** Shipments still moving through the network (booked, not yet delivered/returned). */
    listActiveShipments(shop, maxAgeDays = 60) {
      return db
        .prepare(
          `SELECT * FROM shipments WHERE shop = ? AND status IN ('BOOKED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ON_HOLD')
           AND created_at >= datetime('now', ?) ORDER BY id`,
        )
        .all(shop, `-${maxAgeDays} days`)
        .map(hydrateShipment);
    },

    // ---- tracking events ----
    /** Inserts the event if it is new. Returns true when inserted. */
    insertEvent(shipmentId, event) {
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO tracking_events
             (shipment_id, event_key, code, description, office, office_id, remarks, happened_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          shipmentId,
          event.key,
          event.code ?? null,
          event.description ?? null,
          event.office ?? null,
          event.officeId ?? null,
          event.remarks ?? null,
          event.happenedAt,
          event.source,
        );
      return info.changes > 0;
    },
    listEvents(shipmentId) {
      return db.prepare('SELECT * FROM tracking_events WHERE shipment_id = ? ORDER BY happened_at DESC, id DESC').all(shipmentId);
    },
  };
}

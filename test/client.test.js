import test from 'node:test';
import assert from 'node:assert/strict';
import { IndiaPostClient, IndiaPostError } from '../src/indiapost/client.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('caches the 15 minute token and re-logs in after a 401', async () => {
  let logins = 0;
  let trackCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/v1/access/login')) {
      logins += 1;
      assert.deepEqual(JSON.parse(init.body), { username: '9999999999', password: 'Dop@1234' });
      return json({ success: true, data: { access_token: `t${logins}`, expires_in: 900 } });
    }
    trackCalls += 1;
    if (trackCalls === 2) return json({ message: 'expired' }, 401);
    assert.equal(init.headers.Authorization, `Bearer t${logins}`);
    return json({ success: true, data: [{ booking_details: { article_number: 'RK775227016IN' } }] });
  };
  const client = new IndiaPostClient({ baseUrl: 'https://ip.test/beextcustomer/', username: '9999999999', password: 'Dop@1234', fetchImpl });
  await client.trackBulk(['RK775227016IN']);
  assert.equal(logins, 1);
  const data = await client.trackBulk(['RK775227016IN']); // 401 → login again → retry
  assert.equal(logins, 2);
  assert.equal(data.length, 1);
});

test('surfaces India Post error messages', async () => {
  const fetchImpl = async (url) =>
    String(url).endsWith('/login')
      ? json({ success: true, data: { access_token: 't', expires_in: 900 } })
      : json({ success: false, message: 'Request validation failed', errors: [{ msg: 'bulk must be an array' }] }, 400);
  const client = new IndiaPostClient({ baseUrl: 'https://ip.test', username: 'u', password: 'p', fetchImpl });
  await assert.rejects(client.trackBulk(['RK775227016IN']), (err) => {
    assert.ok(err instanceof IndiaPostError);
    assert.match(err.message, /bulk must be an array/);
    return true;
  });
});

test('rejects failed logins', async () => {
  const bad = new IndiaPostClient({
    baseUrl: 'https://ip.test',
    username: 'u',
    password: 'p',
    fetchImpl: async () => json({ success: false, message: 'Invalid credentials' }, 401),
  });
  await assert.rejects(bad.login(), /Invalid credentials/);
});

test('falls back to "Track single article" when bulk tracking is not subscribed', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(`${init.method} ${u.replace('https://ip.test', '')}`);
    if (u.endsWith('/v1/access/login')) return json({ message: 'Not found' }, 404);
    if (u.endsWith('/v1/access/Login')) return json({ success: true, data: { access_token: 't', expires_in: 900 } });
    if (u.endsWith('/v1/tracking/bulk')) return json({ success: false, message: 'API not subscribed' }, 403);
    if (u.endsWith('/v1/tracking/RM019388105IN')) {
      return json({
        success: true,
        data: {
          trackingNumber: 'RM019388105IN',
          currentStatus: 'Delivered',
          origin: 'Hyderabad, Telangana',
          destination: 'Kochi, Kerala',
          history: [
            { timestamp: '2025-10-26T11:15:00', location: 'Kochi SO', status: 'Item Delivered(Addressee)' },
            { timestamp: '2025-10-24T14:05:00+05:30', location: 'Hyderabad GPO', status: 'Item Booked' },
          ],
        },
      });
    }
    return json({ success: false, message: 'Tracking number does not exist' }, 404);
  };
  const client = new IndiaPostClient({ baseUrl: 'https://ip.test', username: 'u', password: 'p', fetchImpl });
  const items = await client.trackBulk(['RM019388105IN', 'RM000000000IN']);
  assert.equal(items.length, 1, 'unknown articles are skipped');
  const [item] = items;
  assert.equal(item.booking_details.article_number, 'RM019388105IN');
  assert.equal(item.del_status.del_status, 'delivered');
  assert.deepEqual(item.tracking_details.map((t) => t.event), ['Item Delivered(Addressee)', 'Item Booked']);

  const { normalizeTrackingResult } = await import('../src/indiapost/events.js');
  const result = normalizeTrackingResult(item);
  assert.equal(result.delivered, true);
  assert.equal(result.events[0].happenedAt, '2025-10-26T05:45:00.000Z', 'no offset → India time');
  assert.equal(result.events[1].happenedAt, '2025-10-24T08:35:00.000Z', 'explicit +05:30 respected');

  // Remembers: next time goes straight to single-article calls and the working login path.
  calls.length = 0;
  await client.trackBulk(['RM019388105IN']);
  assert.deepEqual(calls, ['GET /v1/tracking/RM019388105IN']);
});

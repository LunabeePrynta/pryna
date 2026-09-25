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

test('surfaces India Post validation messages', async () => {
  const fetchImpl = async (url) =>
    String(url).endsWith('/login')
      ? json({ success: true, data: { access_token: 't', expires_in: 900 } })
      : json({ success: false, message: 'Request validation failed', errors: [{ msg: 'Articles must be an array with 1 to 100,000 items' }] }, 400);
  const client = new IndiaPostClient({ baseUrl: 'https://ip.test', username: 'u', password: 'p', fetchImpl });
  await assert.rejects(client.bookArticles('3000064781', [{}]), (err) => {
    assert.ok(err instanceof IndiaPostError);
    assert.match(err.message, /Articles must be an array/);
    return true;
  });
});

test('rejects failed logins and non-PDF labels', async () => {
  const bad = new IndiaPostClient({
    baseUrl: 'https://ip.test',
    username: 'u',
    password: 'p',
    fetchImpl: async () => json({ success: false, message: 'Invalid credentials' }, 401),
  });
  await assert.rejects(bad.login(), /Invalid credentials/);

  const client = new IndiaPostClient({
    baseUrl: 'https://ip.test',
    username: 'u',
    password: 'p',
    fetchImpl: async (url) =>
      String(url).endsWith('/login')
        ? json({ success: true, data: { access_token: 't', expires_in: 900 } })
        : new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } }),
  });
  await assert.rejects(client.createLabels([{}]), /non-PDF/);
});

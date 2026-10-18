// lib/payments.test.js - plain node, no framework. Run: node lib/payments.test.js
// Must pass with NO env vars (stub/judge path), under 5 seconds.

delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.APP_BASE_URL;

const assert = require('assert');
const http = require('http');
const express = require('express');

let failed = false;
function ok(msg) {
  console.log('ok ' + msg);
}
function fail(msg, err) {
  failed = true;
  console.error('NOT OK ' + msg);
  if (err) console.error(err);
}

async function httpRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      url,
      {
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const payments = require('./payments');

  // status() / stub printed line
  assert.strictEqual(payments.status(), '[payments] stub');
  ok('status() reports stub with no env vars');

  const app = express();
  app.use(express.json());
  payments.mountRoutes(app);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  // Point the adapter's base URL at our ephemeral test server (still no STRIPE_* set).
  process.env.APP_BASE_URL = base;

  try {
    // createPayLink returns a /pay/ URL
    const url = await payments.createPayLink('group1', 'alice', 1234);
    assert.ok(url.includes('/pay/group1/alice'), 'url should contain /pay/group1/alice');
    ok('createPayLink returns a /pay/ URL: ' + url);

    // GET that URL returns HTML containing member name and dollar amount
    const getRes = await httpRequest('GET', url);
    assert.strictEqual(getRes.status, 200);
    assert.ok(getRes.body.includes('alice'), 'page should contain member name');
    assert.ok(getRes.body.includes('12.34'), 'page should contain dollar amount');
    ok('GET /pay/:groupId/:member returns HTML with member name and dollar amount');

    // POST to it fires onPaid handler exactly once with right groupId/member/cents
    let paidCalls = [];
    payments.onPaid((payload) => paidCalls.push(payload));

    const postRes = await httpRequest('POST', url);
    assert.strictEqual(postRes.status, 200);
    assert.strictEqual(paidCalls.length, 1, 'onPaid should fire exactly once');
    assert.strictEqual(paidCalls[0].groupId, 'group1');
    assert.strictEqual(paidCalls[0].member, 'alice');
    assert.strictEqual(paidCalls[0].cents, 1234);
    ok('POST /pay/:groupId/:member fires onPaid exactly once with correct payload');

    // Idempotency: delivering the same event.id twice via /webhook/stripe fires onPaid only once
    let webhookCalls = [];
    payments.onPaid((payload) => webhookCalls.push(payload));

    const event = {
      id: 'evt_test_fixed_id_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          amount_total: 5000,
          metadata: { groupId: 'group2', member: 'bob' },
        },
      },
    };

    const whRes1 = await httpRequest('POST', `${base}/webhook/stripe`, event);
    assert.strictEqual(whRes1.status, 200);
    const whRes2 = await httpRequest('POST', `${base}/webhook/stripe`, event);
    assert.strictEqual(whRes2.status, 200);

    assert.strictEqual(webhookCalls.length, 1, 'onPaid should fire exactly once across duplicate event ids');
    assert.strictEqual(webhookCalls[0].groupId, 'group2');
    assert.strictEqual(webhookCalls[0].member, 'bob');
    assert.strictEqual(webhookCalls[0].cents, 5000);
    ok('delivering the same event.id twice via /webhook/stripe fires onPaid only once');
  } catch (err) {
    fail('unexpected error during test run', err);
  } finally {
    server.close();
  }

  if (failed) {
    console.error('payments.test.js FAILED');
    process.exit(1);
  } else {
    console.log('payments.test.js: all ok');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('payments.test.js FAILED (uncaught)', err);
  process.exit(1);
});

'use strict';

// Plain node test, no framework. Must run with NO env vars so it exercises
// the stub (in-memory) path deterministically. `node lib/bank.test.js`.

delete process.env.NESSIE_API_KEY;
delete process.env.NESSIE_BASE_URL;
delete process.env.NESSIE_CUSTOMER_ID;
delete process.env.NESSIE_ACCOUNT_ID;

const assert = require('node:assert');
const bank = require('./bank');

function ok(msg) {
  console.log(`ok ${msg}`);
}

async function main() {
  assert.strictEqual(bank.status(), '[bank] stub', 'expected stub mode with no env vars');
  ok('status() reports stub mode');

  const id = await bank.createAccount('test-group');
  assert.strictEqual(typeof id, 'string');
  assert.ok(id.length > 0);
  ok('createAccount returns a non-empty string id');

  const initial = await bank.balance(id);
  assert.strictEqual(initial, 0);
  ok('new account starts at balance 0');

  const d1 = await bank.deposit(id, 500, 'group1:alice');
  assert.strictEqual(d1.applied, true);
  assert.strictEqual(d1.balance, 500);
  ok('deposit moves the balance');

  const d2 = await bank.deposit(id, 500, 'group1:alice');
  assert.strictEqual(d2.applied, false);
  assert.strictEqual(d2.balance, 500);
  ok('same idempotency key deposited twice does not double count (applied:false)');

  const afterDupe = await bank.balance(id);
  assert.strictEqual(afterDupe, 500);
  ok('balance unchanged after duplicate key');

  const d3 = await bank.deposit(id, 250, 'group1:bob');
  assert.strictEqual(d3.applied, true);
  assert.strictEqual(d3.balance, 750);
  ok('a different key does add to the balance');

  const w1 = await bank.withdraw(id, 200);
  assert.strictEqual(w1.balance, 550);
  ok('withdraw reduces the balance');

  const finalBalance = await bank.balance(id);
  assert.strictEqual(finalBalance, 550);
  assert.strictEqual(typeof finalBalance, 'number');
  ok('balance() returns cents as a number');

  console.log('ok all bank.test.js checks passed');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});

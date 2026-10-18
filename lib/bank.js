'use strict';

// lib/bank.js — adapter over nessie/client.js (see CONTRACT.md "lib/bank.js").
// Public API is in CENTS. nessie/client.js ALSO takes cents as input on its
// public functions (addContribution({amountCents}), subtractFromAccount({amountCents}))
// and converts to dollars internally only for the outbound Nessie HTTP body
// (`amount: amountCents / 100`). So this adapter must NOT re-convert — cents
// go in to client.js exactly as cents.
//
// Nessie's own account-creation `balance` field comes back in dollars, but we
// never read balance from Nessie directly for the demo path (see mirror below).

const { randomUUID } = require('node:crypto');

const NESSIE_API_KEY = process.env.NESSIE_API_KEY;
const NESSIE_CUSTOMER_ID = process.env.NESSIE_CUSTOMER_ID;

let client = null;
let nessieAvailable = false;

if (NESSIE_API_KEY) {
  try {
    // eslint-disable-next-line global-require
    client = require('../nessie/client');
    nessieAvailable = true;
  } catch (err) {
    // Module failed to load (missing dep, syntax error, etc). Fall back.
    nessieAvailable = false;
  }
}

console.log(nessieAvailable ? '[bank] real (nessie)' : '[bank] stub');

// ---- local mirror state (used on BOTH paths) ----------------------------
// Keeps balance() fast and non-blocking, and is the sole source of truth on
// the stub path. On the real path it is kept in sync with every successful
// Nessie call, and is the fallback of record whenever Nessie errors.
const balances = new Map(); // local id -> cents
const nessieAccountIds = new Map(); // local id -> nessie accountId (real path only)
const appliedKeys = new Set(); // idempotency keys already applied
let localIdCounter = 0;

function newLocalId() {
  localIdCounter += 1;
  return `acct_${localIdCounter}_${randomUUID().slice(0, 8)}`;
}

let warnedThisProcess = false;
function warnFallback(action, err) {
  // TODO(service): surface this to a real metrics/alerting path instead of console.
  if (!warnedThisProcess) {
    console.error(
      `[bank] Nessie ${action} failed, falling back to local state: ${err && err.message}`
    );
    warnedThisProcess = true;
  }
}

// Nessie's addContribution/subtractFromAccount require whole-dollar cents
// (>=100, multiple of 100) and specific id formats. Centralize that check so
// we fail fast into the local fallback instead of throwing out of this module.
function nessieAccepts(cents) {
  return Number.isSafeInteger(cents) && cents >= 100 && cents % 100 === 0;
}

function sanitizeForPaymentId(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_');
}

// ---- public API -----------------------------------------------------------

async function createAccount(label) {
  const id = newLocalId();
  balances.set(id, 0);

  if (nessieAvailable) {
    try {
      const nickname = String(label || 'group').slice(0, 100) || 'group';
      const result = await client.createBookingAccount({
        customerId: NESSIE_CUSTOMER_ID,
        nickname,
      });
      nessieAccountIds.set(id, result.accountId);
    } catch (err) {
      // TODO(service): retry/queue account creation once Nessie recovers.
      warnFallback('createBookingAccount', err);
    }
  }

  return id;
}

async function deposit(id, cents, key) {
  if (appliedKeys.has(key)) {
    return { balance: balances.get(id) || 0, applied: false };
  }

  const nessieAccountId = nessieAccountIds.get(id);
  if (nessieAvailable && nessieAccountId && nessieAccepts(cents)) {
    try {
      const paymentId = `pi_${sanitizeForPaymentId(key)}_${randomUUID().replace(/-/g, '')}`;
      await client.addContribution({
        accountId: nessieAccountId,
        amountCents: cents,
        paymentId,
      });
    } catch (err) {
      // TODO(service): reconcile against readAccountDeposits once Nessie recovers.
      warnFallback('addContribution', err);
    }
  }

  const next = (balances.get(id) || 0) + cents;
  balances.set(id, next);
  appliedKeys.add(key);

  return { balance: next, applied: true };
}

async function withdraw(id, cents) {
  const nessieAccountId = nessieAccountIds.get(id);
  if (nessieAvailable && nessieAccountId && nessieAccepts(cents)) {
    try {
      const operationId = `op_${randomUUID().replace(/-/g, '')}`.slice(0, 100);
      await client.subtractFromAccount({
        accountId: nessieAccountId,
        amountCents: cents,
        operationId,
      });
    } catch (err) {
      // TODO(service): reconcile withdrawals against Nessie once it recovers.
      warnFallback('subtractFromAccount', err);
    }
  }

  const next = (balances.get(id) || 0) - cents;
  balances.set(id, next);

  return { balance: next };
}

async function balance(id) {
  // Always the local mirror — never blocks the demo on a network call.
  return balances.get(id) || 0;
}

function status() {
  return nessieAvailable ? '[bank] real (nessie)' : '[bank] stub';
}

module.exports = {
  createAccount,
  deposit,
  withdraw,
  balance,
  status,
};

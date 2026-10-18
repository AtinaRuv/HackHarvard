// Local developer tools. These are not public HTTP endpoints.
const Stripe = require('stripe');
const { execFileSync } = require('node:child_process');
const { openPaymentStore } = require('../payments/store');
const { summarizeContributions, summarizeSpending } = require('../payments/balance');
const { buildBookingSpender } = require('../payments/spend');
const { createBookingAccount } = require('../nessie/client');

async function readNessie(suffix) {
  if (!process.env.NESSIE_BASE_URL || !process.env.NESSIE_API_KEY) throw new Error('Configure Nessie settings in .env.');
  const url = new URL(process.env.NESSIE_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a credential-free HTTPS Nessie URL.');
  url.pathname = `${url.pathname.replace(/\/$/, '')}${suffix}`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('key', process.env.NESSIE_API_KEY);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Rejected');
    return await response.json();
  } catch { throw new Error('Could not read Nessie. Check account ID, API key, and connectivity.'); }
}

async function main() {
  const command = process.argv[2];
  if (command === 'account') {
    if (process.argv[3] !== '--create') throw new Error('Account creation requires --create. Run only once for a new test account.');
    const account = await createBookingAccount({ customerId: process.env.NESSIE_CUSTOMER_ID, nickname: 'Leash chunk 3 test' });
    console.log(JSON.stringify(account, null, 2));
    console.log('Save accountId as NESSIE_ACCOUNT_ID in .env. Do not recreate it on retries.');
    return;
  }
  const shareId = `${process.env.DEMO_PAYMENT_ATTEMPT_ID || 'demo-chunk3-001'}-share`;
  const store = openPaymentStore();
  try {
    const share = store.get(shareId);
    const contribution = store.contribution(shareId);
    if (command === 'spend') {
      if (process.env.ENABLE_PAYMENT_DEMO !== 'true' || process.env.NODE_ENV === 'production' || process.argv[3] !== '--confirm') {
        throw new Error('Local demo spending requires ENABLE_PAYMENT_DEMO=true and --confirm.');
      }
      if (!share) throw new Error('Create and fund the demo booking first.');
      // Fixed local test approval. The team's backend must supply its actual
      // authorization policy; this callback is never mounted as a public route.
      const spend = buildBookingSpender({ store, authorizeBooking: async bookingId => ({
        bookingId, accountId: share.accountId, amountCents: 1000,
        authorizationId: 'demo-chunk4-approval-001',
      }) });
      console.log(JSON.stringify(await spend({ bookingId: share.bookingId, operationId: 'demo-chunk4-spend-001' }), null, 2));
      return;
    }
    if (command === 'status') {
      const accountId = share?.accountId || process.env.NESSIE_ACCOUNT_ID;
      if (!accountId) throw new Error('Set NESSIE_ACCOUNT_ID in .env first.');
      const account = await readNessie(`/accounts/${encodeURIComponent(accountId)}`);
      const deposits = await readNessie(`/accounts/${encodeURIComponent(accountId)}/deposits`);
      if (!Array.isArray(deposits)) throw new Error('Nessie did not return a deposit list.');
      const withdrawals = await readNessie(`/accounts/${encodeURIComponent(accountId)}/withdrawals`);
      const spending = store.spendingForAccount(accountId);
      const contributionSummary = summarizeContributions({ contributions: store.recordedContributions(accountId), deposits });
      console.log(JSON.stringify({
        shareId, accountId, amountCents: share?.amountCents,
        contribution: contribution || null,
        nessieAccountBalance: account.balance,
        ...contributionSummary,
        ...summarizeSpending({ contributionSummary, spending, withdrawals }),
        spending,
        leashWithdrawals: withdrawals.filter(w => typeof w.description === 'string' && w.description.startsWith('Leash spending '))
          .map(w => ({ id: w._id, amount: w.amount, status: w.status, description: w.description })),
        stripeDeposits: deposits.filter(d => typeof d.description === 'string' && d.description.startsWith('Stripe test contribution '))
          .map(d => ({ id: d._id, amount: d.amount, status: d.status, description: d.description })),
      }, null, 2));
      return;
    }
    if (command === 'replay') {
      // Only replay an already-recorded contribution, never an uncredited payment.
      if (!share || contribution?.status !== 'recorded') throw new Error('Replay is allowed only after this demo contribution is recorded.');
      const key = process.env.STRIPE_SECRET_KEY;
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!/^(rk|sk)_test_/.test(key || '') || !secret?.startsWith('whsec_')) throw new Error('Configure Stripe test key and webhook secret.');
      const stripe = new Stripe(key);
      let event;
      try {
        event = await stripe.events.retrieve(contribution.eventId);
      } catch (error) {
        if (error.type !== 'StripePermissionError') throw error;
        // The app's restricted key may omit Events read. Use the developer's
        // existing CLI login without broadening the application's permissions.
        try {
          event = JSON.parse(execFileSync('stripe', ['events', 'retrieve', contribution.eventId], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
          }));
        } catch {
          throw new Error('Cannot read the saved event. Sign into the matching account with stripe login, then retry replay.');
        }
      }
      if (event.livemode !== false || event.data.object.id !== share.sessionId) throw new Error('Stripe event does not match the saved test checkout.');
      const payload = JSON.stringify(event);
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
      const response = await fetch('http://127.0.0.1:6767/payments/webhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: payload,
      });
      const result = await response.json();
      console.log(JSON.stringify(result, null, 2));
      if (!response.ok || result.status !== 'already_recorded') throw new Error('Replay did not return already_recorded. Inspect the server and ledger.');
      return;
    }
    throw new Error('Use account --create, status, replay, or spend --confirm.');
  } finally { store.close(); }
}
main().catch(error => {
  // Known setup errors are safe; Stripe/network errors may contain private details.
  const safe = !error.type && !(error instanceof TypeError);
  console.error(safe ? error.message : 'Demo tool failed. Check configuration and service access.');
  process.exitCode = 1;
});

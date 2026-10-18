// lib/payments.js - adapter. See CONTRACT.md.
//
// Decoupled on purpose: this module NEVER requires lib/bank.js or lib/chat.js.
// The orchestrator wires onPaid(handler) to bank.deposit + chat.send.
//
// Judge path (no STRIPE_SECRET_KEY): createPayLink returns a local /pay/:groupId/:member
// URL. GET renders a big mobile-friendly "Pay" button. Tapping it POSTs to the same
// path; the server builds a Stripe-SHAPED event and feeds it straight into the same
// internal handler used by POST /webhook/stripe (no HTTP self-request), then shows a
// "Paid" confirmation page.
//
// Real path (STRIPE_SECRET_KEY set): creates a real test-mode Stripe Checkout Session
// with metadata {groupId, member} and returns session.url. POST /webhook/stripe verifies
// the signature with STRIPE_WEBHOOK_SECRET when present.
//
// NOTE FOR ORCHESTRATOR: for real Stripe signature verification to work, mount raw body
// parsing on the webhook path BEFORE express.json(), e.g.:
//   app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
//   app.use(express.json());
//   payments.mountRoutes(app);

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'http://localhost:6767';

function appBaseUrl() {
  return process.env.APP_BASE_URL || DEFAULT_BASE_URL;
}

function isReal() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// groupId:member -> cents. Simpler than threading the amount through the URL,
// and we fall back to a ?cents= query param if the map entry is ever missing.
const pendingAmounts = new Map();

// Idempotency: event.id -> true. The same Stripe event delivered twice must
// fire onPaid exactly once.
const processedEvents = new Set();

let paidHandler = null;

function onPaid(handler) {
  paidHandler = handler;
}

function keyFor(groupId, member) {
  return `${groupId}:${member}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let _stripeClient = null;
function getStripeClient() {
  if (!_stripeClient) {
    const Stripe = require('stripe');
    _stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripeClient;
}

// The single internal handler used by BOTH the real POST /webhook/stripe route
// and the local judge-path POST /pay/:groupId/:member route. Idempotent on event.id.
function handleStripeEvent(event) {
  if (!event || typeof event.id !== 'string' || !event.id) {
    return { received: true, status: 'ignored' };
  }
  if (processedEvents.has(event.id)) {
    return { received: true, status: 'already_processed' };
  }
  processedEvents.add(event.id);

  if (event.type !== 'checkout.session.completed') {
    return { received: true, status: 'ignored' };
  }

  const obj = (event.data && event.data.object) || {};
  const metadata = obj.metadata || {};
  const { groupId, member } = metadata;
  const cents = obj.amount_total;

  if (!groupId || !member || !Number.isFinite(cents)) {
    return { received: true, status: 'ignored' };
  }

  if (typeof paidHandler === 'function') {
    paidHandler({ groupId, member, cents });
  }

  return { received: true, status: 'paid' };
}

async function createPayLink(groupId, member, cents) {
  pendingAmounts.set(keyFor(groupId, member), cents);

  if (isReal()) {
    try {
      const stripe = getStripeClient();
      const base = appBaseUrl();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: cents,
              product_data: { name: `Group payment: ${member}` },
            },
            quantity: 1,
          },
        ],
        metadata: { groupId, member },
        success_url: `${base}/pay/${encodeURIComponent(groupId)}/${encodeURIComponent(member)}?paid=1`,
        cancel_url: `${base}/pay/${encodeURIComponent(groupId)}/${encodeURIComponent(member)}`,
      });
      return session.url;
    } catch (err) {
      // TODO(service): real Stripe checkout session creation failed; falls back to
      // the local pay page below so the demo keeps working.
      console.error('[payments] real Stripe checkout failed, falling back to local pay page:', err.message);
    }
  }

  return `${appBaseUrl()}/pay/${encodeURIComponent(groupId)}/${encodeURIComponent(member)}`;
}

function renderPayPage(groupId, member, cents) {
  const dollars = (cents / 100).toFixed(2);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay ${escapeHtml(member)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f172a;
    color: #f1f5f9;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    padding: 24px;
  }
  .card {
    background: #1e293b;
    border-radius: 20px;
    padding: 40px 28px;
    max-width: 420px;
    width: 100%;
    text-align: center;
    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
  }
  h1 { font-size: 1.1rem; margin: 0 0 8px; color: #94a3b8; font-weight: 500; }
  .member { font-size: 2rem; font-weight: 700; margin: 0 0 24px; color: #f8fafc; word-break: break-word; }
  .amount { font-size: 3.2rem; font-weight: 800; margin: 0 0 32px; color: #4ade80; }
  button {
    font-size: 1.4rem;
    font-weight: 700;
    padding: 20px 32px;
    width: 100%;
    border: none;
    border-radius: 14px;
    background: #4ade80;
    color: #052e16;
    cursor: pointer;
  }
  button:active { transform: scale(0.98); }
</style>
</head>
<body>
<div class="card">
  <h1>Payment request for</h1>
  <p class="member">${escapeHtml(member)}</p>
  <p class="amount">$${dollars}</p>
  <form method="POST" action="/pay/${encodeURIComponent(groupId)}/${encodeURIComponent(member)}">
    <button type="submit">Pay $${dollars}</button>
  </form>
</div>
</body>
</html>`;
}

function renderPaidPage(groupId, member, cents) {
  const dollars = (cents / 100).toFixed(2);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paid</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f172a;
    color: #f1f5f9;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    padding: 24px;
  }
  .card {
    background: #1e293b;
    border-radius: 20px;
    padding: 40px 28px;
    max-width: 420px;
    width: 100%;
    text-align: center;
    box-shadow: 0 10px 40px rgba(0,0,0,0.4);
  }
  .check { font-size: 4rem; margin: 0 0 12px; }
  h1 { font-size: 2rem; margin: 0 0 20px; color: #4ade80; }
  .member { font-size: 1.6rem; font-weight: 700; margin: 0 0 8px; color: #f8fafc; word-break: break-word; }
  .amount { font-size: 2.4rem; font-weight: 800; margin: 0; color: #f8fafc; }
</style>
</head>
<body>
<div class="card">
  <div class="check">&#9989;</div>
  <h1>Paid</h1>
  <p class="member">${escapeHtml(member)}</p>
  <p class="amount">$${dollars}</p>
</div>
</body>
</html>`;
}

function mountRoutes(app) {
  app.post('/webhook/stripe', (req, res) => {
    const key = process.env.STRIPE_SECRET_KEY;
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try {
      if (key && secret && Buffer.isBuffer(req.body)) {
        const stripe = getStripeClient();
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
      } else if (Buffer.isBuffer(req.body)) {
        event = JSON.parse(req.body.toString('utf8') || '{}');
      } else {
        event = req.body;
      }
    } catch (err) {
      return res.status(400).json({ error: 'Invalid Stripe payload or signature.' });
    }
    const result = handleStripeEvent(event);
    return res.json(result);
  });

  app.get('/pay/:groupId/:member', (req, res) => {
    const { groupId, member } = req.params;
    const queryCents = req.query.cents !== undefined ? parseInt(req.query.cents, 10) : undefined;
    let cents = pendingAmounts.get(keyFor(groupId, member));
    if (!Number.isFinite(cents) && Number.isFinite(queryCents)) {
      cents = queryCents;
      pendingAmounts.set(keyFor(groupId, member), cents);
    }
    if (!Number.isFinite(cents)) {
      return res.status(404).type('html').send('<h1>Payment link not found or expired.</h1>');
    }
    return res.type('html').send(renderPayPage(groupId, member, cents));
  });

  app.post('/pay/:groupId/:member', (req, res) => {
    const { groupId, member } = req.params;
    const cents = pendingAmounts.get(keyFor(groupId, member));
    if (!Number.isFinite(cents)) {
      return res.status(404).type('html').send('<h1>Payment link not found or expired.</h1>');
    }

    // Build a Stripe-SHAPED event and deliver it through the SAME internal
    // handler the real /webhook/stripe route uses (direct call, no HTTP hop).
    const event = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${crypto.randomUUID()}`,
          amount_total: cents,
          metadata: { groupId, member },
        },
      },
    };
    handleStripeEvent(event);

    return res.type('html').send(renderPaidPage(groupId, member, cents));
  });
}

function status() {
  return isReal() ? '[payments] real (stripe)' : '[payments] stub';
}

console.log(status());

module.exports = {
  createPayLink,
  mountRoutes,
  onPaid,
  status,
  // exposed for tests only
  _handleStripeEvent: handleStripeEvent,
};

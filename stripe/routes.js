const express = require('express');
const {
  createParticipantCheckout,
} = require('./client');

const { openPaymentStore } = require('../payments/store');
const router = express.Router();

// This fixed record stands in for the team's booking database.
// The real booking flow will supply these values later.
const demoShare = Object.freeze({
  bookingId: 'demo-booking-001',
  participantId: 'demo-participant-001',
  shareId: 'demo-share-001',
  paymentAttemptId: 'demo-attempt-001',
  amountCents: 2500,
  currency: 'usd',
});

// Keep the same checkout while this server is running.
// Sharing the promise also handles two requests arriving together.
let checkoutPromise;

router.post('/demo/checkout', async (req, res) => {
  // This route is only for local development.
  // Do not expose it as the production payment endpoint.
  const isLocal =
    req.socket.remoteAddress === '127.0.0.1' ||
    req.socket.remoteAddress === '::1' ||
    req.socket.remoteAddress === '::ffff:127.0.0.1';

  if (
    process.env.ENABLE_PAYMENT_DEMO !== 'true' ||
    process.env.NODE_ENV === 'production' ||
    !isLocal
  ) {
    return res.sendStatus(404);
  }

  // Require JSON. Our test command below sends this header.
  if (!req.is('application/json')) {
    return res.status(415).json({
      error: 'Send the request as application/json.',
    });
  }

  // This endpoint takes no payment details from the caller.
  // The amount and participant references come from demoShare.
  if (req.body && Object.keys(req.body).length > 0) {
    return res.status(400).json({
      error: 'The demo endpoint does not accept payment details.',
    });
  }

  try {
    if (!checkoutPromise) {
      checkoutPromise = (async () => {
        const accountId = process.env.NESSIE_ACCOUNT_ID;
        if (!accountId) throw new Error('Set NESSIE_ACCOUNT_ID to the booking account before checkout.');
        // A fresh ID avoids reusing the checkout paid during chunk 2.
        const attempt = process.env.DEMO_PAYMENT_ATTEMPT_ID || 'demo-chunk3-001';
        const share = { ...demoShare, accountId, shareId: `${attempt}-share`, paymentAttemptId: attempt };
        const store = openPaymentStore();
        try {
          const saved = store.register(share);
          if (saved.sessionId) return { sessionId: saved.sessionId, checkoutUrl: saved.checkoutUrl };
          const checkout = await createParticipantCheckout(share);
          store.bindCheckout(share.shareId, checkout);
          return checkout;
        } finally { store.close(); }
      })();
    }

    const checkout = await checkoutPromise;

    res.set('Cache-Control', 'no-store');

    return res.json({
      ...checkout,
      amountCents: demoShare.amountCents,
      currency: demoShare.currency,
    });
  } catch (error) {
    // Allow another attempt using the same Stripe idempotency key.
    checkoutPromise = undefined;

    // This is a local-only diagnostic. It never prints the API key.
    console.error('Checkout creation failed:', error.message);

    return res.status(502).json({
      error: 'Could not prepare the test checkout. Check the server terminal.',
    });
  }
});

// These pages only describe where the browser returned.
// They do not confirm payment or update Nessie.
router.get('/success', (req, res) => {
  res.type('text').send(
    'You returned from checkout. Payment still needs server verification.'
  );
});

router.get('/cancel', (req, res) => {
  res.type('text').send(
    'You left checkout. This page does not change your payment status.'
  );
});

module.exports = router;
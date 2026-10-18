const Stripe = require('stripe');
const { openPaymentStore } = require('../payments/store');
const { addContribution } = require('../nessie/client');

const supportedEvents = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

function buildWebhookHandler({ stripeClient, store, webhookSecret, deposit = addContribution, logger = console }) {
  return async (req, res) => {
    let event;
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error('Raw body required.');
      event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch {
      return res.status(400).json({ error: 'Invalid Stripe signature or payload.' });
    }
    if (event.livemode !== false || !supportedEvents.has(event.type)) {
      return res.json({ received: true, status: 'ignored' });
    }
    try {
      // Retrieve current Stripe state; do not use browser-submitted payment details.
      const session = await stripeClient.checkout.sessions.retrieve(event.data.object.id);
      if (session.livemode !== false || session.mode !== 'payment' || session.payment_status !== 'paid') {
        return res.json({ received: true, status: 'not_paid' });
      }
      const refs = session.metadata || {};
      const share = typeof refs.shareId === 'string' ? store.get(refs.shareId) : undefined;
      const paymentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (!share || share.sessionId !== session.id || session.client_reference_id !== share.shareId ||
          ['bookingId', 'participantId', 'shareId', 'paymentAttemptId'].some(k => refs[k] !== share[k]) ||
          session.amount_total !== share.amountCents || session.currency !== share.currency ||
          typeof paymentId !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(paymentId)) {
        logger.warn('Stripe contribution rejected: checkout does not match a saved share.');
        return res.status(400).json({ error: 'Payment does not match a saved share.' });
      }
      if (!store.claim(share.shareId, paymentId, event.id)) {
        const previous = store.contribution(share.shareId);
        if (previous?.status === 'recorded' && previous.paymentId === paymentId) {
          return res.json({ received: true, status: 'already_recorded' });
        }
        // Includes a crash after sending the deposit. Never blindly send it twice.
        return res.status(503).json({ error: 'Contribution in progress or needs review. Do not resend the Nessie deposit manually.' });
      }
      try {
        const { depositId } = await deposit({ accountId: share.accountId, amountCents: share.amountCents, paymentId });
        store.finish(share.shareId, depositId);
        logger.info(`Nessie contribution recorded for share ${share.shareId}.`);
        return res.json({ received: true, status: 'recorded' });
      } catch {
        store.review(share.shareId);
        logger.error(`Nessie contribution needs review for share ${share.shareId}.`);
        return res.status(503).json({ error: 'Nessie contribution needs review before retrying.' });
      }
    } catch {
      logger.error('Stripe contribution processing failed.');
      return res.status(503).json({ error: 'Could not process payment notification.' });
    }
  };
}

let handler;
function stripeWebhook(req, res) {
  if (!handler) {
    const key = process.env.STRIPE_SECRET_KEY;
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!/^(rk|sk)_test_/.test(key || '') || !secret?.startsWith('whsec_')) {
      return res.status(503).json({ error: 'Configure Stripe test key and webhook signing secret.' });
    }
    handler = buildWebhookHandler({ stripeClient: new Stripe(key), store: openPaymentStore(), webhookSecret: secret });
  }
  return handler(req, res);
}
module.exports = { buildWebhookHandler, stripeWebhook };

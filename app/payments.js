import Stripe from 'stripe';

export class Payments {
  constructor({ mode = 'demo', baseUrl = 'http://127.0.0.1:6767', stripe } = {}) {
    this.mode = mode; this.baseUrl = baseUrl;
    if (mode === 'stripe') {
      if (!/^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || '') && !stripe) throw new Error('STRIPE_SECRET_KEY must be a Stripe test key.');
      this.stripe = stripe || new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
    }
  }
  async checkout(booking, participant) {
    if (this.mode === 'demo') return { id: `demo_${participant.id}`, url: `${this.baseUrl}/pay/${participant.access}`, livemode: false };
    const metadata = { bookingId: booking.id, participantId: participant.id };
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: participant.id, metadata,
      payment_intent_data: { metadata },
      line_items: [{ price_data: { currency: 'usd', unit_amount: participant.amountCents, product_data: { name: `Group stay · ${booking.requested.title || 'Airbnb'}` } }, quantity: 1 }],
      success_url: `${this.baseUrl}/pay/${participant.access}?returned=1`, cancel_url: `${this.baseUrl}/pay/${participant.access}?cancelled=1`,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    }, { idempotencyKey: `checkout_${booking.id}_${participant.id}` });
    if (session.livemode !== false || !session.url) throw new Error('Stripe did not return a test checkout.');
    return { id: session.id, url: session.url, livemode: false, expiresAt: session.expires_at * 1000 };
  }
  event(raw, signature) {
    if (!this.stripe || !process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook is not configured.');
    return this.stripe.webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET);
  }
  async validateSession(session) {
    if (this.mode === 'demo') return session;
    return this.stripe.checkout.sessions.retrieve(session.id, { expand: ['payment_intent'] });
  }
  async refund(booking, participant) {
    if (this.mode === 'demo') return { id: `refund_${participant.id}`, status: 'succeeded' };
    const result = await this.stripe.refunds.create({ payment_intent: participant.paymentIntent, amount: participant.amountCents,
      metadata: { bookingId: booking.id, participantId: participant.id } }, { idempotencyKey: `refund_${booking.id}_${participant.id}_${participant.refundAttempt || 0}` });
    return { id: result.id, status: result.status };
  }
  async refundStatus(id) { return this.mode === 'demo' ? { id, status: 'succeeded' } : this.stripe.refunds.retrieve(id); }
  async expire(id) {
    if (this.mode === 'stripe') {
      const session = await this.stripe.checkout.sessions.retrieve(id);
      if (session.status === 'open') await this.stripe.checkout.sessions.expire(id);
    }
  }
}

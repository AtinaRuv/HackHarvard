const Stripe = require('stripe');

// A label that helps us recognize this checkout integration in Stripe.
const INTEGRATION_LABEL = 'leash_checkout_qmzptnva';

// Tests can pass a fake Stripe client here.
// Our backend will pass the real client using the test key.
function buildCheckoutCreator({ stripeClient, appBaseUrl }) {
  const appUrl = new URL(appBaseUrl);

  // HTTP is okay on our own computer. Deployment needs HTTPS.
  const isLocal =
    appUrl.hostname === 'localhost' ||
    appUrl.hostname === '127.0.0.1';

  if (
    appUrl.protocol !== 'https:' &&
    !(appUrl.protocol === 'http:' && isLocal)
  ) {
    throw new Error('Use HTTPS for the app URL outside local development.');
  }

  if (appUrl.username || appUrl.password) {
    throw new Error('The app URL must not contain login credentials.');
  }

  return async function createParticipantCheckout(share = {}) {
    // These details must come from our backend's saved booking data.
    // The participant's browser does not choose the amount.
    const {
      bookingId,
      participantId,
      shareId,
      paymentAttemptId,
      amountCents,
      currency,
    } = share;

    const references = {
      bookingId,
      participantId,
      shareId,
      paymentAttemptId,
    };

    // Use record IDs rather than personal information.
    for (const [name, value] of Object.entries(references)) {
      if (
        typeof value !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(value)
      ) {
        throw new Error(
          `${name} must contain 1 to 100 letters, numbers, underscores, or hyphens.`
        );
      }
    }

    // Use whole cents. For example, 2500 means $25.00.
    // This first demo accepts USD amounts starting at 50 cents.
    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents < 50 ||
      amountCents > 99_999_999
    ) {
      throw new Error(
        'amountCents must be a whole number from 50 to 99999999.'
      );
    }

    if (currency !== 'usd') {
      throw new Error('This demo currently supports usd only.');
    }

    // Our server controls where the person returns after checkout.
    const successUrl = new URL('/payments/success', appUrl);
    const cancelUrl = new URL('/payments/cancel', appUrl);

    // These references connect the payment to its booking later.
    // Never put API keys or private bank details in metadata.
    const metadata = {
      bookingId,
      participantId,
      shareId,
      paymentAttemptId,
    };

    let session;

    try {
      session = await stripeClient.checkout.sessions.create(
        {
          mode: 'payment',

          // Stripe hosts the form and handles the payment details.
          line_items: [
            {
              price_data: {
                currency,
                unit_amount: amountCents,
                product_data: {
                  name: 'Group booking contribution',
                },
              },
              quantity: 1,
            },
          ],

          client_reference_id: shareId,
          metadata,

          // Keep the same references on the underlying payment.
          payment_intent_data: {
            metadata,
          },

          integration_identifier: INTEGRATION_LABEL,
          success_url: successUrl.toString(),
          cancel_url: cancelUrl.toString(),
        },
        {
          // Retrying the same attempt uses the same key.
          // The backend must keep this ID stable across retries.
          idempotencyKey: `checkout_${paymentAttemptId}`,
        }
      );
    } catch {
      // Return a clear error without exposing Stripe request details.
      throw new Error(
        'Could not create checkout. Retry with the same payment-attempt ID.'
      );
    }

    // Only accept a usable session from the test environment.
    if (
      !session ||
      typeof session.id !== 'string' ||
      !session.id ||
      typeof session.url !== 'string' ||
      !session.url ||
      session.livemode !== false
    ) {
      throw new Error(
        'Stripe did not return a usable test checkout session.'
      );
    }

    // A checkout link does not mean someone has paid.
    // The webhook in chunk 3 will confirm that.
    return {
      sessionId: session.id,
      checkoutUrl: session.url,
    };
  };
}

// This is the function our backend will call.
async function createParticipantCheckout(share) {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  const appBaseUrl = process.env.APP_BASE_URL;

  // Block live keys so this demo cannot accidentally take real money.
  if (
    typeof apiKey !== 'string' ||
    !/^(rk|sk)_test_/.test(apiKey)
  ) {
    throw new Error('Set a Stripe test API key in STRIPE_SECRET_KEY.');
  }

  if (!appBaseUrl) {
    throw new Error('Set APP_BASE_URL before creating checkout.');
  }

  const stripeClient = new Stripe(apiKey);

  const createCheckout = buildCheckoutCreator({
    stripeClient,
    appBaseUrl,
  });

  return createCheckout(share);
}

module.exports = {
  createParticipantCheckout,
  buildCheckoutCreator,
};
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCheckoutCreator,
  createParticipantCheckout,
} = require('./client');

// A fictional share stored by our backend.
function sampleShare() {
  return {
    bookingId: 'booking-123',
    participantId: 'participant-456',
    shareId: 'share-789',
    paymentAttemptId: 'attempt-001',
    amountCents: 2500,
    currency: 'usd',
  };
}

// Each test gets its own fake Stripe client and request list.
function setup({
  appBaseUrl = 'http://localhost:6767',
  session,
  fail = false,
} = {}) {
  const requests = [];

  const stripeClient = {
    checkout: {
      sessions: {
        create: async (details, options) => {
          requests.push({ details, options });

          if (fail) {
            throw new Error('Private Stripe request details');
          }

          return session === undefined
            ? {
                id: 'cs_test_example',
                url: 'https://checkout.stripe.com/test-example',
                livemode: false,
              }
            : session;
        },
      },
    },
  };

  return {
    requests,
    createCheckout: buildCheckoutCreator({
      stripeClient,
      appBaseUrl,
    }),
  };
}

test('creates checkout for the exact share and returns its link', async () => {
  const { createCheckout, requests } = setup();
  const share = sampleShare();

  const result = await createCheckout(share);

  assert.deepEqual(result, {
    sessionId: 'cs_test_example',
    checkoutUrl: 'https://checkout.stripe.com/test-example',
  });

  assert.equal(requests.length, 1);

  const { details, options } = requests[0];

  assert.equal(details.mode, 'payment');
  assert.equal(details.line_items.length, 1);
  assert.equal(details.line_items[0].quantity, 1);
  assert.equal(details.line_items[0].price_data.unit_amount, 2500);
  assert.equal(details.line_items[0].price_data.currency, 'usd');

  assert.equal(details.client_reference_id, share.shareId);

  assert.deepEqual(details.metadata, {
    bookingId: share.bookingId,
    participantId: share.participantId,
    shareId: share.shareId,
    paymentAttemptId: share.paymentAttemptId,
  });

  assert.deepEqual(
    details.payment_intent_data.metadata,
    details.metadata
  );

  assert.equal(
    details.success_url,
    'http://localhost:6767/payments/success'
  );

  assert.equal(
    details.cancel_url,
    'http://localhost:6767/payments/cancel'
  );

  assert.equal(
    options.idempotencyKey,
    'checkout_attempt-001'
  );

  // Leave eligible payment methods to the Stripe settings.
  assert.equal(
    Object.hasOwn(details, 'payment_method_types'),
    false
  );
});

test('uses the same retry key for the same payment attempt', async () => {
  const { createCheckout, requests } = setup();

  await createCheckout(sampleShare());
  await createCheckout(sampleShare());

  assert.equal(
    requests[0].options.idempotencyKey,
    requests[1].options.idempotencyKey
  );

  // This checks the key we send.
  // Stripe itself handles matching requests with that key.
});

test('uses a different key for a different payment attempt', async () => {
  const { createCheckout, requests } = setup();

  await createCheckout(sampleShare());

  await createCheckout({
    ...sampleShare(),
    paymentAttemptId: 'attempt-002',
  });

  assert.notEqual(
    requests[0].options.idempotencyKey,
    requests[1].options.idempotencyKey
  );
});

test('rejects missing or invalid record IDs before calling Stripe', async () => {
  const fields = [
    'bookingId',
    'participantId',
    'shareId',
    'paymentAttemptId',
  ];

  for (const field of fields) {
    for (const value of [undefined, '', 'has spaces', 'x'.repeat(101)]) {
      const { createCheckout, requests } = setup();

      await assert.rejects(
        createCheckout({
          ...sampleShare(),
          [field]: value,
        }),
        new RegExp(field)
      );

      assert.equal(requests.length, 0);
    }
  }
});

test('rejects invalid amounts before calling Stripe', async () => {
  const invalidAmounts = [
    undefined,
    '2500',
    0,
    -100,
    49,
    25.5,
    NaN,
    Infinity,
    100_000_000,
  ];

  for (const amountCents of invalidAmounts) {
    const { createCheckout, requests } = setup();

    await assert.rejects(
      createCheckout({
        ...sampleShare(),
        amountCents,
      }),
      /amountCents/
    );

    assert.equal(requests.length, 0);
  }
});

test('accepts the lowest supported USD amount', async () => {
  const { createCheckout, requests } = setup();

  await createCheckout({
    ...sampleShare(),
    amountCents: 50,
  });

  assert.equal(
    requests[0].details.line_items[0].price_data.unit_amount,
    50
  );
});

test('rejects other currencies in this demo', async () => {
  const { createCheckout, requests } = setup();

  await assert.rejects(
    createCheckout({
      ...sampleShare(),
      currency: 'eur',
    }),
    /usd only/
  );

  assert.equal(requests.length, 0);
});

test('rejects HTTP outside local development', () => {
  assert.throws(
    () => setup({ appBaseUrl: 'http://example.com' }),
    /Use HTTPS/
  );
});

test('accepts an HTTPS app address', async () => {
  const { createCheckout, requests } = setup({
    appBaseUrl: 'https://example.com',
  });

  await createCheckout(sampleShare());

  assert.equal(
    requests[0].details.success_url,
    'https://example.com/payments/success'
  );
});

test('rejects login credentials inside the app address', () => {
  assert.throws(
    () => setup({
      appBaseUrl: 'https://user:password@example.com',
    }),
    /must not contain login credentials/
  );
});

test('keeps private Stripe error details out of the returned error', async () => {
  const { createCheckout, requests } = setup({ fail: true });

  await assert.rejects(
    createCheckout(sampleShare()),
    (error) => {
      assert.match(error.message, /same payment-attempt ID/);
      assert.equal(
        error.message.includes('Private Stripe request details'),
        false
      );

      return true;
    }
  );

  assert.equal(requests.length, 1);
});

test('rejects a live session or an incomplete response', async () => {
  const invalidSessions = [
    null,
    {},
    {
      id: 'cs_live_example',
      url: 'https://checkout.stripe.com/example',
      livemode: true,
    },
    {
      id: 'cs_test_example',
      url: '',
      livemode: false,
    },
    {
      id: '',
      url: 'https://checkout.stripe.com/example',
      livemode: false,
    },
  ];

  for (const session of invalidSessions) {
    const { createCheckout } = setup({ session });

    await assert.rejects(
      createCheckout(sampleShare()),
      /usable test checkout session/
    );
  }
});

test('requires a test key and app address', async () => {
  // Temporarily replace settings without reading or printing their values.
  const originalKey = process.env.STRIPE_SECRET_KEY;
  const originalUrl = process.env.APP_BASE_URL;

  try {
    delete process.env.STRIPE_SECRET_KEY;

    await assert.rejects(
      createParticipantCheckout(sampleShare()),
      /test API key/
    );

    process.env.STRIPE_SECRET_KEY = 'sk_live_fake';

    await assert.rejects(
      createParticipantCheckout(sampleShare()),
      /test API key/
    );

    process.env.STRIPE_SECRET_KEY = 'rk_test_fake';
    delete process.env.APP_BASE_URL;

    await assert.rejects(
      createParticipantCheckout(sampleShare()),
      /Set APP_BASE_URL/
    );
  } finally {
    // Put everything back even if a test fails.
    if (originalKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalKey;
    }

    if (originalUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = originalUrl;
    }
  }
});
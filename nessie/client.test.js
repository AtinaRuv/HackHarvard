const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createBookingAccount } = require('./client');

const originalFetch = global.fetch;
const originalKey = process.env.NESSIE_API_KEY;
const originalUrl = process.env.NESSIE_BASE_URL;

const input = {
  customerId: 'customer-123',
  nickname: 'Boston trip',
};

// Make fake responses look like the parts of fetch that our code uses.
function reply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  process.env.NESSIE_API_KEY = 'fake-test-key';
  process.env.NESSIE_BASE_URL = 'https://nessie.example';

  // No test should make a real internet request.
  global.fetch = async () => {
    throw new Error('No fake response was provided.');
  };
});

afterEach(() => {
  global.fetch = originalFetch;

  if (originalKey === undefined) {
    delete process.env.NESSIE_API_KEY;
  } else {
    process.env.NESSIE_API_KEY = originalKey;
  }

  if (originalUrl === undefined) {
    delete process.env.NESSIE_BASE_URL;
  } else {
    process.env.NESSIE_BASE_URL = originalUrl;
  }
});

test('creates an empty account and returns its ID', async () => {
  let requestCount = 0;
  let sentNickname;

  global.fetch = async (url, options) => {
    requestCount += 1;

    assert.equal(url.origin, 'https://nessie.example');
    assert.equal(url.pathname, '/customers/customer-123/accounts');
    assert.equal(url.searchParams.get('key'), 'fake-test-key');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.redirect, 'error');

    const body = JSON.parse(options.body);
    sentNickname = body.nickname;

    // The nickname contains the trip name and a unique reference.
    assert.match(
      sentNickname,
      /^Boston trip \[[0-9a-f-]{36}\]$/
    );

    assert.deepEqual(body, {
      type: 'Checking',
      nickname: sentNickname,
      rewards: 0,
      balance: 0,
    });

    return reply({
      objectCreated: {
        _id: 'account-456',
        nickname: sentNickname,
        balance: 0,
      },
    }, 201);
  };

  const result = await createBookingAccount({
    customerId: ' customer-123 ',
    nickname: ' Boston trip ',
  });

  assert.deepEqual(result, {
    accountId: 'account-456',
    customerId: 'customer-123',
    nickname: sentNickname,
    balance: 0,
  });

  assert.equal(requestCount, 1);
});

test('also accepts an account returned directly', async () => {
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);

    return reply({
      _id: 'account-456',
      nickname: body.nickname,
      balance: 0,
    }, 201);
  };

  const result = await createBookingAccount(input);

  assert.equal(result.accountId, 'account-456');
});

test('looks up the correct account after a success message', async () => {
  const methods = [];
  let sentNickname;

  global.fetch = async (url, options) => {
    methods.push(options.method);

    if (options.method === 'POST') {
      sentNickname = JSON.parse(options.body).nickname;
      return reply('Account created', 201);
    }

    assert.equal(url.pathname, '/accounts');
    assert.equal(url.searchParams.get('key'), 'fake-test-key');
    assert.equal(options.redirect, 'error');

    return reply([
      // Same nickname, wrong customer. Our code must ignore it.
      {
        _id: 'wrong-customer-account',
        customer_id: 'someone-else',
        nickname: sentNickname,
      },

      // Same customer, wrong nickname. Ignore this one too.
      {
        _id: 'older-account',
        customer_id: 'customer-123',
        nickname: 'Boston trip',
      },

      // This is the only exact match.
      {
        _id: 'account-456',
        customer_id: 'customer-123',
        nickname: sentNickname,
        balance: 0,
      },
    ]);
  };

  const result = await createBookingAccount(input);

  assert.equal(result.accountId, 'account-456');
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('rejects missing API settings', async () => {
  for (const setting of ['NESSIE_API_KEY', 'NESSIE_BASE_URL']) {
    const savedValue = process.env[setting];
    delete process.env[setting];

    await assert.rejects(
      createBookingAccount(input),
      /Set NESSIE_API_KEY and NESSIE_BASE_URL/
    );

    process.env[setting] = savedValue;
  }
});

test('rejects a missing customer ID or nickname', async () => {
  await assert.rejects(
    createBookingAccount({ nickname: 'Boston trip' }),
    /Provide the Nessie customer ID/
  );

  await assert.rejects(
    createBookingAccount({
      customerId: 'customer-123',
      nickname: '   ',
    }),
    /Provide a nickname/
  );
});

test('rejects an unencrypted API address', async () => {
  process.env.NESSIE_BASE_URL = 'http://nessie.example';

  await assert.rejects(
    createBookingAccount(input),
    /must use HTTPS/
  );
});

test('reports a rejected creation request without a lookup', async () => {
  let requestCount = 0;

  global.fetch = async () => {
    requestCount += 1;
    return reply('unauthorized', 401);
  };

  await assert.rejects(
    createBookingAccount(input),
    /status 401/
  );

  assert.equal(requestCount, 1);
});

test('does not retry or expose the key after a connection failure', async () => {
  let requestCount = 0;

  global.fetch = async () => {
    requestCount += 1;
    throw new Error('Connection failed with key=fake-test-key');
  };

  await assert.rejects(
    createBookingAccount(input),
    (error) => {
      assert.match(error.message, /before retrying/);
      assert.equal(error.message.includes('fake-test-key'), false);
      return true;
    }
  );

  assert.equal(requestCount, 1);
});

test('handles an unreadable creation response', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 201,
    json: async () => {
      throw new Error('Invalid JSON');
    },
  });

  await assert.rejects(
    createBookingAccount(input),
    /unreadable response/
  );
});

test('stops when the lookup finds no matching account', async () => {
  const methods = [];

  global.fetch = async (url, options) => {
    methods.push(options.method);

    if (options.method === 'POST') {
      return reply('Account created', 201);
    }

    return reply([]);
  };

  await assert.rejects(
    createBookingAccount(input),
    /lookup found 0 matches/
  );

  // It reads once instead of creating another account.
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('stops when the lookup finds multiple matching accounts', async () => {
  let sentNickname;

  global.fetch = async (url, options) => {
    if (options.method === 'POST') {
      sentNickname = JSON.parse(options.body).nickname;
      return reply('Account created', 201);
    }

    return reply([
      {
        _id: 'account-one',
        customer_id: 'customer-123',
        nickname: sentNickname,
      },
      {
        _id: 'account-two',
        customer_id: 'customer-123',
        nickname: sentNickname,
      },
    ]);
  };

  await assert.rejects(
    createBookingAccount(input),
    /lookup found 2 matches/
  );
});

test('reports a failed lookup without creating another account', async () => {
  const methods = [];

  global.fetch = async (url, options) => {
    methods.push(options.method);

    if (options.method === 'POST') {
      return reply('Account created', 201);
    }

    throw new Error('Connection failed');
  };

  await assert.rejects(
    createBookingAccount(input),
    /lookup failed/
  );

  assert.deepEqual(methods, ['POST', 'GET']);
});

test('reports a rejected lookup', async () => {
  global.fetch = async (url, options) => {
    if (options.method === 'POST') {
      return reply('Account created', 201);
    }

    return reply('unauthorized', 401);
  };

  await assert.rejects(
    createBookingAccount(input),
    /lookup returned status 401/
  );
});

test('rejects an unreadable account list', async () => {
  global.fetch = async (url, options) => {
    if (options.method === 'POST') {
      return reply('Account created', 201);
    }

    return {
      ok: true,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    };
  };

  await assert.rejects(
    createBookingAccount(input),
    /account list was unreadable/
  );
});

test('rejects a response that is not an account list', async () => {
  global.fetch = async (url, options) => {
    if (options.method === 'POST') {
      return reply('Account created', 201);
    }

    return reply({ message: 'Unexpected response' });
  };

  await assert.rejects(
    createBookingAccount(input),
    /account list was unexpected/
  );
});
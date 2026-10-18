const { randomUUID } = require('node:crypto');

// Creates one simulated account when our backend calls this function.
async function createBookingAccount({ customerId, nickname } = {}) {
  // Read the private settings. The actual key stays out of this file.
  const apiKey = process.env.NESSIE_API_KEY;
  const baseUrl = process.env.NESSIE_BASE_URL;

  if (!apiKey || !baseUrl) {
    throw new Error(
      'Set NESSIE_API_KEY and NESSIE_BASE_URL before creating an account.'
    );
  }

  // The account needs an existing customer to own it.
  if (typeof customerId !== 'string' || !customerId.trim()) {
    throw new Error('Provide the Nessie customer ID.');
  }

  if (typeof nickname !== 'string' || !nickname.trim()) {
    throw new Error('Provide a nickname for the booking account.');
  }

  // Add a unique reference so two bookings with the same name stay separate.
  const accountNickname = `${nickname.trim()} [${randomUUID()}]`;

  // Build the request address from our server settings.
  const url = new URL(baseUrl);

  if (url.protocol !== 'https:') {
    throw new Error('The Nessie API URL must use HTTPS.');
  }

  url.pathname =
    `${url.pathname.replace(/\/$/, '')}` +
    `/customers/${encodeURIComponent(customerId.trim())}/accounts`;

  url.search = '';
  url.hash = '';
  url.searchParams.set('key', apiKey);

  let response;

  try {
    // Start the account empty. Contributions come in a later chunk.
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        type: 'Checking',
        nickname: accountNickname,
        rewards: 0,
        balance: 0,
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch {
    // A connection failure does not tell us whether Nessie created it.
    // Do not automatically retry or print the URL containing our key.
    throw new Error(
      `Could not confirm account creation. Check Nessie for ` +
      `"${accountNickname}" before retrying.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Nessie rejected account creation with status ${response.status}.`
    );
  }

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      'Nessie returned an unreadable response. Check Nessie before retrying.'
    );
  }

  // Some responses include the account inside objectCreated.
  // Others may return the account directly.
  let account = result?.objectCreated;

  if (!account && result && typeof result._id === 'string') {
    account = result;
  }

  // If Nessie only returned a success message, find the account by reading
  // the account list. We do not send another creation request.
  if (!account || typeof account._id !== 'string' || !account._id.trim()) {
    const lookupUrl = new URL(baseUrl);

    lookupUrl.pathname =
      `${lookupUrl.pathname.replace(/\/$/, '')}/accounts`;

    lookupUrl.search = '';
    lookupUrl.hash = '';
    lookupUrl.searchParams.set('key', apiKey);

    let lookupResponse;

    try {
      lookupResponse = await fetch(lookupUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      throw new Error(
        `Account creation succeeded, but lookup failed. ` +
        `Check Nessie for "${accountNickname}" before retrying.`
      );
    }

    if (!lookupResponse.ok) {
      throw new Error(
        `Account creation succeeded, but lookup returned status ` +
        `${lookupResponse.status}. Check Nessie before retrying.`
      );
    }

    let accounts;

    try {
      accounts = await lookupResponse.json();
    } catch {
      throw new Error(
        'Account creation succeeded, but the account list was unreadable. ' +
        'Check Nessie before retrying.'
      );
    }

    if (!Array.isArray(accounts)) {
      throw new Error(
        'Account creation succeeded, but the account list was unexpected. ' +
        'Check Nessie before retrying.'
      );
    }

    // Match both the customer and the exact unique nickname.
    const matches = accounts.filter((candidate) =>
      candidate &&
      candidate.customer_id === customerId.trim() &&
      candidate.nickname === accountNickname &&
      typeof candidate._id === 'string' &&
      candidate._id.trim().length > 0
    );

    // Stop if the match is missing or unclear. Never pick an account at random.
    if (matches.length !== 1) {
      throw new Error(
        `Account creation succeeded, but lookup found ${matches.length} ` +
        `matches for "${accountNickname}". Check Nessie before retrying.`
      );
    }

    account = matches[0];
  }

  // Our backend will save this ID against the booking later.
  return {
    accountId: account._id,
    customerId: customerId.trim(),
    nickname: account.nickname,
    balance: account.balance,
  };
}

// Makes the function available to our server and test file.
module.exports = { createBookingAccount };


// Called only after the backend verifies Stripe and claims the contribution.
// Nessie is a simulation: this records a deposit, not a Stripe funds transfer.
async function addContribution({ accountId, amountCents, paymentId } = {}) {
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId) ||
      typeof paymentId !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(paymentId)) {
    throw new Error('Provide valid account and Stripe payment IDs.');
  }
  if (!Number.isSafeInteger(amountCents) || amountCents < 100 ||
      amountCents > 99_999_999 || amountCents % 100 !== 0) {
    throw new Error('Nessie contributions must use positive whole USD dollars in cents.');
  }
  const apiKey = process.env.NESSIE_API_KEY;
  const baseUrl = process.env.NESSIE_BASE_URL;
  if (!apiKey || !baseUrl) throw new Error('Set NESSIE_API_KEY and NESSIE_BASE_URL.');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a credential-free HTTPS Nessie URL.');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/accounts/${encodeURIComponent(accountId)}/deposits`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('key', apiKey);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        medium: 'balance', transaction_date: new Date().toISOString().slice(0, 10),
        status: 'completed', amount: amountCents / 100,
        description: `Stripe test contribution ${paymentId}`,
      }),
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Nessie rejected the deposit.');
    const result = await response.json();
    const depositId = result?.objectCreated?._id || result?._id;
    if (typeof depositId !== 'string' || !depositId.trim()) throw new Error('Missing deposit ID.');
    return { depositId };
  } catch {
    // No automatic POST retry: even a timeout might have created the deposit.
    throw new Error('Could not confirm Nessie deposit. Review Nessie before retrying.');
  }
}
module.exports.addContribution = addContribution;

async function readAccountDeposits(accountId) {
  const url = nessieAccountUrl(accountId, 'deposits');
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Rejected');
    const deposits = await response.json();
    if (!Array.isArray(deposits)) throw new Error('Expected deposits');
    return deposits;
  } catch { throw new Error('Could not read Nessie deposits. No spending was started.'); }
}

function nessieAccountUrl(accountId, resource) {
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId)) throw new Error('Invalid Nessie account ID.');
  if (!process.env.NESSIE_BASE_URL || !process.env.NESSIE_API_KEY) throw new Error('Configure Nessie settings.');
  const url = new URL(process.env.NESSIE_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a credential-free HTTPS Nessie URL.');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/accounts/${encodeURIComponent(accountId)}/${resource}`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('key', process.env.NESSIE_API_KEY);
  return url;
}

// Internal low-level helper. Call through payments/spend.js so funds are reserved.
async function subtractFromAccount({ accountId, amountCents, operationId } = {}) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 99_999_999 || amountCents % 100 !== 0) {
    throw new Error('Spending must use positive whole USD dollars in cents.');
  }
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(operationId)) throw new Error('Invalid spending operation ID.');
  const url = nessieAccountUrl(accountId, 'withdrawals');
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ medium: 'balance', transaction_date: new Date().toISOString().slice(0, 10),
        status: 'completed', amount: amountCents / 100, description: `Leash spending ${operationId}` }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Rejected');
    const result = await response.json();
    const withdrawalId = result?.objectCreated?._id || result?._id;
    if (typeof withdrawalId !== 'string' || !withdrawalId.trim()) throw new Error('Missing withdrawal ID');
    return { withdrawalId };
  } catch {
    throw new Error('Could not confirm Nessie withdrawal. Review Nessie before retrying.');
  }
}
module.exports.readAccountDeposits = readAccountDeposits;
module.exports.subtractFromAccount = subtractFromAccount;

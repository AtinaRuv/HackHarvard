const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

// Local demo storage. Keep this file across restarts; do not commit it.
function openPaymentStore(filename = process.env.PAYMENT_STORE_PATH || path.join(__dirname, '../.data/payments.sqlite')) {
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS shares (
      shareId TEXT PRIMARY KEY, bookingId TEXT NOT NULL, participantId TEXT NOT NULL,
      paymentAttemptId TEXT UNIQUE NOT NULL, accountId TEXT NOT NULL,
      amountCents INTEGER NOT NULL, currency TEXT NOT NULL,
      sessionId TEXT UNIQUE, checkoutUrl TEXT
    );
    CREATE TABLE IF NOT EXISTS contributions (
      shareId TEXT PRIMARY KEY, paymentId TEXT UNIQUE NOT NULL,
      eventId TEXT NOT NULL, status TEXT NOT NULL,
      depositId TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spending (
      operationId TEXT PRIMARY KEY, bookingId TEXT NOT NULL,
      authorizationId TEXT UNIQUE NOT NULL, accountId TEXT NOT NULL,
      amountCents INTEGER NOT NULL, status TEXT NOT NULL,
      withdrawalId TEXT UNIQUE, updatedAt TEXT NOT NULL
    );
  `);
  return {
    register(share) {
      for (const key of ['shareId', 'bookingId', 'participantId', 'paymentAttemptId', 'accountId']) {
        if (typeof share[key] !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(share[key])) {
          throw new Error(`Invalid ${key}.`);
        }
      }
      // Nessie's current schema takes integer amounts in simulated dollars.
      // Reject fractional dollars before checkout rather than rounding a payment.
      if (!Number.isSafeInteger(share.amountCents) || share.amountCents < 100 ||
          share.amountCents > 99_999_999 || share.amountCents % 100 !== 0 || share.currency !== 'usd') {
        throw new Error('Nessie-connected demo shares must use whole USD dollars.');
      }
      db.prepare(`INSERT OR IGNORE INTO shares
        (shareId, bookingId, participantId, paymentAttemptId, accountId, amountCents, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...['shareId', 'bookingId', 'participantId', 'paymentAttemptId', 'accountId', 'amountCents', 'currency'].map(k => share[k]));
      const saved = this.get(share.shareId);
      if (!saved || ['bookingId', 'participantId', 'paymentAttemptId', 'accountId', 'amountCents', 'currency'].some(k => saved[k] !== share[k])) {
        throw new Error('Saved share differs. Use new share and attempt IDs for a new payment.');
      }
      return saved;
    },
    get(shareId) { return db.prepare('SELECT * FROM shares WHERE shareId = ?').get(shareId); },
    bindCheckout(shareId, { sessionId, checkoutUrl }) {
      const saved = this.get(shareId);
      if (!saved || (saved.sessionId && saved.sessionId !== sessionId)) throw new Error('Checkout does not match saved share.');
      db.prepare('UPDATE shares SET sessionId = ?, checkoutUrl = ? WHERE shareId = ?').run(sessionId, checkoutUrl, shareId);
    },
    contribution(shareId) { return db.prepare('SELECT * FROM contributions WHERE shareId = ?').get(shareId); },
    claim(shareId, paymentId, eventId) {
      // A unique row is claimed BEFORE Nessie is called. SQLite also serializes
      // simultaneous deliveries and other processes using this same database.
      return db.prepare(`INSERT OR IGNORE INTO contributions
        (shareId, paymentId, eventId, status, updatedAt) VALUES (?, ?, ?, 'processing', ?)`)
        .run(shareId, paymentId, eventId, new Date().toISOString()).changes === 1;
    },
    finish(shareId, depositId) {
      db.prepare("UPDATE contributions SET status = 'recorded', depositId = ?, updatedAt = ? WHERE shareId = ?")
        .run(depositId, new Date().toISOString(), shareId);
    },
    review(shareId) {
      db.prepare("UPDATE contributions SET status = 'needs_review', updatedAt = ? WHERE shareId = ?")
        .run(new Date().toISOString(), shareId);
    },
    recordedContributions(accountId) {
      return db.prepare(`SELECT c.paymentId, c.depositId, s.amountCents FROM contributions c
        JOIN shares s ON s.shareId = c.shareId
        WHERE s.accountId = ? AND c.status = 'recorded'`).all(accountId);
    },
    bookingAccount(bookingId) {
      const rows = db.prepare('SELECT DISTINCT accountId FROM shares WHERE bookingId = ?').all(bookingId);
      if (rows.length !== 1) throw new Error('Booking must map to exactly one saved Nessie account.');
      const bookings = db.prepare('SELECT DISTINCT bookingId FROM shares WHERE accountId = ?').all(rows[0].accountId);
      if (bookings.length !== 1) throw new Error('Spending requires a dedicated account for this booking.');
      return rows[0].accountId;
    },
    spending(operationId) { return db.prepare('SELECT * FROM spending WHERE operationId = ?').get(operationId); },
    spendingForAccount(accountId) { return db.prepare('SELECT * FROM spending WHERE accountId = ?').all(accountId); },
    reserveSpending(input, confirmedCents) {
      // Serialize the balance check and reservation, including across processes.
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = this.spending(input.operationId);
        if (existing) {
          if (['bookingId', 'authorizationId', 'accountId', 'amountCents'].some(k => existing[k] !== input[k])) {
            throw new Error('Operation ID already belongs to different spending details.');
          }
          db.exec('COMMIT');
          return { claimed: false, record: existing };
        }
        if (db.prepare('SELECT 1 FROM spending WHERE authorizationId = ?').get(input.authorizationId)) {
          throw new Error('This booking authorization already has a spending operation.');
        }
        const reserved = db.prepare('SELECT COALESCE(SUM(amountCents), 0) AS total FROM spending WHERE accountId = ?').get(input.accountId).total;
        if (!Number.isSafeInteger(confirmedCents) || input.amountCents > confirmedCents - reserved) {
          throw new Error('Insufficient verified simulated funds.');
        }
        db.prepare(`INSERT INTO spending
          (operationId, bookingId, authorizationId, accountId, amountCents, status, updatedAt)
          VALUES (?, ?, ?, ?, ?, 'processing', ?)`)
          .run(input.operationId, input.bookingId, input.authorizationId, input.accountId, input.amountCents, new Date().toISOString());
        db.exec('COMMIT');
        return { claimed: true, record: this.spending(input.operationId) };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    finishSpending(operationId, withdrawalId) {
      db.prepare("UPDATE spending SET status = 'recorded', withdrawalId = ?, updatedAt = ? WHERE operationId = ?")
        .run(withdrawalId, new Date().toISOString(), operationId);
    },
    reviewSpending(operationId) {
      db.prepare("UPDATE spending SET status = 'needs_review', updatedAt = ? WHERE operationId = ?")
        .run(new Date().toISOString(), operationId);
    },
    close() { db.close(); },
  };
}
module.exports = { openPaymentStore };

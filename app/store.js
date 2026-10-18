import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

// One server process owns this database. Every mutation is committed before an
// external side effect; a restart never silently repeats a bank operation.
export class Store {
  constructor(directory = 'data') {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = resolve(this.directory, 'signing.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    this.secret = process.env.TOKEN_SIGNING_SECRET || readFileSync(keyPath, 'utf8');
    this.db = new DatabaseSync(resolve(this.directory, 'bookings.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, body TEXT NOT NULL);');
  }
  all() { return this.db.prepare('SELECT body FROM bookings').all().map(r => JSON.parse(r.body)); }
  get(id) {
    const row = this.db.prepare('SELECT body FROM bookings WHERE id = ?').get(id);
    if (!row) throw Object.assign(new Error('Booking not found.'), { status: 404 });
    return JSON.parse(row.body);
  }
  save(booking) {
    booking.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO bookings VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(booking.id, JSON.stringify(booking));
    return booking;
  }
  change(id, fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const booking = this.get(id); fn(booking); this.save(booking); this.db.exec('COMMIT'); return booking; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}

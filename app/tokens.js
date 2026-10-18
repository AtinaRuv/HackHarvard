import {staynestUrl} from './staynest.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function airbnbUrl(value) {
  const demo=staynestUrl(value);if(demo)return demo;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/^(www\.)?airbnb\.com$/.test(url.hostname) || !/^\/rooms\/\d+\/?$/.test(url.pathname)) {
    throw new Error('Send an https://www.airbnb.com/rooms/… listing URL.');
  }
  // Tracking and redirect parameters are never browser instructions.
  const clean = new URL(`https://www.airbnb.com${url.pathname.replace(/\/$/, '')}`);
  for (const field of ['check_in', 'check_out', 'adults']) if (url.searchParams.has(field)) clean.searchParams.set(field, url.searchParams.get(field));
  return clean.href;
}

const fields = ['bookingId', 'listingId', 'listingUrl', 'checkIn', 'checkOut', 'guests', 'currency', 'totalCents', 'destination', 'answers'];
function canonical(token) {
  return JSON.stringify(fields.map(key => key === 'answers'
    ? [key, Object.entries(token.answers || {}).sort(([a], [b]) => a.localeCompare(b))]
    : [key, token[key]]));
}
export function validateFacts(facts) {
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!date(facts.checkIn) || !date(facts.checkOut) || facts.checkOut <= facts.checkIn) throw new Error('Valid check-in and check-out dates are required.');
  if (!Number.isInteger(facts.guests) || facts.guests < 1 || facts.guests > 50) throw new Error('Guest count must be 1–50.');
  if (facts.currency !== 'USD' || !Number.isSafeInteger(facts.totalCents) || facts.totalCents < 50 || facts.totalCents > 99_999_999) throw new Error('A final USD total including taxes is required.');
}
export function sign(token, secret) {
  validateFacts(token);
  return { ...token, signature: createHmac('sha256', secret).update(canonical(token)).digest('hex') };
}
export function verify(token, secret) {
  if (!token || !/^[a-f0-9]{64}$/.test(token.signature || '')) return false;
  const expected = createHmac('sha256', secret).update(canonical(token)).digest();
  return timingSafeEqual(expected, Buffer.from(token.signature, 'hex'));
}
export function compare(initial, final, secret) {
  const differences = fields.filter(field => canonical({ ...initial, [field]: final[field] }) !== canonical(initial));
  if (!verify(initial, secret) || !verify(final, secret)) differences.unshift('signature');
  return { status: differences.length ? 'BLOCK' : 'OK', differences };
}

// Smoke test for the fraud wrapper. No env vars, no network. node lib/fraud.test.js
const fs = require('fs');
const path = require('path');
const fraud = require('./fraud');

let failed = 0;
function ok(name, cond) { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) failed++; }
const fx = (f) => fs.readFileSync(path.join(__dirname, '../fraud/fixtures', f), 'utf8');

const LISTING = 'http://localhost:6767/airbnb/rooms/12345';
const FINAL = 'http://localhost:6767/airbnb/rooms/12345/book';

const scan = fraud.signals(fx('paris_listing.html'), LISTING);
ok('signals returns a status', scan.status === 'OK' || scan.status === 'WARN');
ok('scam listing warns', fraud.signals(fx('scam_listing.html'), LISTING).status === 'WARN');

const group = {};
const token = fraud.approve(group, fx('paris_listing.html'), LISTING);
ok('approve mints a token onto the group', group.approvedToken === token && !!token.listingId);

const before = group.approvedToken.guests;
fraud.amend(group, { guests: before + 2 });
ok('amend re-signs with the change', group.approvedToken.guests === before + 2);
fraud.amend(group, { guests: before });

const good = fraud.clear(group, fx('paris_final.html'), FINAL);
ok('matching final page clears', good.status === 'OK');

const bad = fraud.clear(group, fx('attack_price_final.html'), FINAL);
ok('tampered price blocks', bad.status === 'BLOCK');
ok('block gives plain-word reasons', Array.isArray(bad.reasons) && bad.reasons.length > 0 && /price/i.test(bad.reasons.join(' ')));
console.log(bad.reasons.map(r => '       - ' + r).join('\n'));

console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);

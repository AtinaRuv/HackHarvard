const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { extract, ExtractError } = require('./extract');
const { isAirbnbHost } = require('./signals');
const {
    createInitialToken,
    createFinalToken,
    editToken,
    compareTokens,
    signToken,
    verifyToken,
    listingSignals,
    TokenError
} = require('./tokens');
const tokensModule = require('./tokens');

const FIXTURES = path.join(__dirname, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));

// Looked up by name so inserting a fixture case cannot silently repoint a test.
function caseNamed(name) {
    const found = expected.cases.find((testCase) => testCase.name === name);
    if (!found) {
        throw new Error(`no fixture case named ${name}`);
    }
    return found;
}

let passed = 0;
const failures = [];

function test(name, body) {
    try {
        body();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push({ name, error });
        console.log(`  FAIL ${name}`);
        console.log(`       ${error.message.split('\n').join('\n       ')}`);
    }
}

function fixture(file) {
    return fs.readFileSync(path.join(FIXTURES, file), 'utf8');
}

function tokenFor(spec) {
    return createInitialToken(fixture(spec.file), spec.url);
}

// --- the fixture spec in expected.json -------------------------------------------------

function runCompareCase(testCase) {
    const initial = testCase.initialToken
        ? JSON.parse(fixture(testCase.initialToken))
        : tokenFor(testCase.initial);

    let approved = initial;
    if (testCase.edit) {
        const edited = editToken(initial, testCase.edit);
        assert.deepStrictEqual(edited.changed, testCase.changed, 'edited fields');
        approved = edited.token;
    }

    const final = createFinalToken(fixture(testCase.final.file), testCase.final.url);
    const result = compareTokens(approved, final);
    assert.deepStrictEqual(result.fields, testCase.fields, 'mismatched fields');
    assert.strictEqual(result.status, testCase.status, 'status');
}

function runSignalsCase(testCase) {
    const result = listingSignals(fixture(testCase.listing.file), testCase.listing.url);
    assert.deepStrictEqual([...result.codes].sort(), [...testCase.codes].sort(), 'signal codes');
    assert.strictEqual(result.status, testCase.status, 'status');
    assert.strictEqual(result.signals.length, testCase.codes.length, 'one detail per code');
}

console.log('fixture cases');
for (const testCase of expected.cases) {
    test(`${testCase.kind}: ${testCase.name}`, () => {
        if (testCase.kind === 'compare') {
            runCompareCase(testCase);
        } else if (testCase.kind === 'signals') {
            runSignalsCase(testCase);
        } else {
            throw new Error(`unknown case kind "${testCase.kind}"`);
        }
    });
}

// --- dates ------------------------------------------------------------------------------

console.log('\ndate parsing');

test('ISO range "2026-01-01 to 2026-01-05" is read off a page with no date attributes', () => {
    const token = createFinalToken(fixture('iso_dates_final.html'), 'https://www.airbnb.com/rooms/73105522');
    assert.strictEqual(token.checkIn, '2026-01-01');
    assert.strictEqual(token.checkOut, '2026-01-05');
    // The day part of an ISO date must not be mistaken for the guest count.
    assert.strictEqual(token.guests, 2);
});

test('an ISO range survives whatever separates the two dates', () => {
    const separators = [' to ', ' - ', ' – ', ' until ', '</p><p>Checkout: '];
    for (const separator of separators) {
        const html = `<html><body><h1>Stay</h1>
            <p>Dates: 2026-01-01${separator}2026-01-05</p>
            <p>Guests: 3 guests</p><p>Amount due: $500.00 total</p></body></html>`;
        const token = extract(html, 'https://www.airbnb.com/rooms/1', 'checkout');
        assert.strictEqual(token.checkIn, '2026-01-01', `separator ${JSON.stringify(separator)}`);
        assert.strictEqual(token.checkOut, '2026-01-05', `separator ${JSON.stringify(separator)}`);
        assert.strictEqual(token.guests, 3, `separator ${JSON.stringify(separator)}`);
    }
});

test('date attributes win over text when a page carries both', () => {
    const html = `<html><body><h1>Stay</h1>
        <div data-testid="checkin-date" data-date="2026-03-01">Mar 1, 2026</div>
        <div data-testid="checkout-date" data-date="2026-03-04">Mar 4, 2026</div>
        <p>Originally 2026-04-01 to 2026-04-08</p>
        <p>2 guests</p><p>$300.00 total</p></body></html>`;
    const token = extract(html, 'https://www.airbnb.com/rooms/1', 'checkout');
    assert.strictEqual(token.checkIn, '2026-03-01');
    assert.strictEqual(token.checkOut, '2026-03-04');
});

test('month-name ranges still parse in both spellings', () => {
    const cases = [
        ['Dates: Nov 5 - 9, 2026', '2026-11-05', '2026-11-09'],
        ['Dates: December 28, 2026 - January 3, 2027', '2026-12-28', '2027-01-03']
    ];
    for (const [dates, checkIn, checkOut] of cases) {
        const html = `<html><body><h1>Stay</h1><p>${dates}</p>
            <p>2 guests</p><p>$400.00 total</p></body></html>`;
        const token = extract(html, 'https://www.airbnb.com/rooms/1', 'checkout');
        assert.strictEqual(token.checkIn, checkIn, dates);
        assert.strictEqual(token.checkOut, checkOut, dates);
    }
});

test('a page with no readable dates fails loudly', () => {
    const html = '<html><body><h1>Stay</h1><p>2 guests</p><p>$400.00 total</p></body></html>';
    assert.throws(() => extract(html, 'https://www.airbnb.com/rooms/1', 'checkout'), ExtractError);
});

// --- signing ----------------------------------------------------------------------------

console.log('\nsigning');

test('a freshly minted token verifies', () => {
    const token = tokenFor(caseNamed('paris').initial);
    assert.ok(verifyToken(token));
});

test('changing a signed field breaks the signature', () => {
    const token = tokenFor(caseNamed('paris').initial);
    for (const field of ['listingId', 'checkIn', 'checkOut', 'guests', 'totalPrice', 'currency']) {
        const tampered = { ...token, [field]: typeof token[field] === 'number' ? token[field] + 1 : 'x' };
        assert.ok(!verifyToken(tampered), `${field} should be covered by the signature`);
    }
});

test('descriptive fields are outside the signature', () => {
    const token = tokenFor(caseNamed('paris').initial);
    for (const field of ['title', 'host', 'source', 'createdAt']) {
        assert.ok(verifyToken({ ...token, [field]: 'reworded' }), `${field} should not be signed`);
    }
});

test('an unsigned or empty signature never verifies', () => {
    const token = extract(fixture('paris_listing.html'), 'https://www.airbnb.com/rooms/51234567', 'listing');
    assert.ok(!verifyToken(token));
    assert.ok(!verifyToken({ ...token, sig: '' }));
    assert.ok(!verifyToken(null));
});

test('the signature does not depend on key order', () => {
    const token = tokenFor(caseNamed('paris').initial);
    const reordered = {};
    for (const key of Object.keys(token).reverse()) {
        reordered[key] = token[key];
    }
    assert.strictEqual(signToken(reordered).sig, token.sig);
});

// --- edits ------------------------------------------------------------------------------

console.log('\nedits');

test('an edit re-signs the token', () => {
    const initial = tokenFor(caseNamed('paris').initial);
    const { token, changed } = editToken(initial, { guests: 5 });
    assert.deepStrictEqual(changed, ['guests']);
    assert.ok(verifyToken(token));
    assert.notStrictEqual(token.sig, initial.sig);
});

test('unknown fields are ignored and unchanged values are not reported', () => {
    const initial = tokenFor(caseNamed('paris').initial);
    const { changed, ignored } = editToken(initial, { nickname: 'trip', guests: initial.guests });
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(ignored, ['nickname']);
});

test('the listing cannot be edited out from under an approval', () => {
    const initial = tokenFor(caseNamed('paris').initial);
    assert.throws(() => editToken(initial, { listingId: '69876543' }), TokenError);
});

// --- comparison -------------------------------------------------------------------------

console.log('\ncomparison');

test('a token compared against itself passes', () => {
    const token = tokenFor(caseNamed('paris').initial);
    assert.deepStrictEqual(compareTokens(token, token), { status: 'OK', fields: [], reasons: [] });
});

test('every mismatched field is reported, not just the first', () => {
    const initial = tokenFor(caseNamed('paris').initial);
    const final = signToken({ ...initial, guests: 9, totalPrice: 4000 });
    const result = compareTokens(initial, final);
    assert.strictEqual(result.status, 'BLOCK');
    assert.deepStrictEqual(result.fields, ['guests', 'totalPrice']);
    assert.strictEqual(result.reasons.length, 2);
});

test('a forged final token is caught even when its fields match', () => {
    const initial = tokenFor(caseNamed('paris').initial);
    const forged = { ...initial, sig: 'f'.repeat(64) };
    assert.deepStrictEqual(compareTokens(initial, forged).fields, ['signature']);
});

test('a blocked comparison explains itself in words', () => {
    const initial = tokenFor(caseNamed('paris_price').initial);
    const final = createFinalToken(fixture('attack_price_final.html'), caseNamed('paris_price').final.url);
    const result = compareTokens(initial, final);
    assert.match(result.reasons.join(' '), /total price changed from 900 to 1240/);
});

// --- signals ----------------------------------------------------------------------------

console.log('\nsignals');

test('airbnb lookalike domains are not treated as Airbnb', () => {
    for (const host of ['www.airbnb.com', 'airbnb.com', 'airbnb.co.uk', 'fr.airbnb.com']) {
        assert.ok(isAirbnbHost(host), `${host} is Airbnb`);
    }
    for (const host of ['airbnb-deals-paris.com', 'airbnb.com.verify-booking.net', 'notairbnb.com', '']) {
        assert.ok(!isAirbnbHost(host), `${host} is not Airbnb`);
    }
});

test('every signal carries a human-readable detail', () => {
    const result = listingSignals(fixture('scam_listing.html'), 'https://airbnb-deals-paris.com/rooms/99887766');
    for (const signal of result.signals) {
        assert.ok(signal.detail && signal.detail.length > 0, `${signal.code} needs a detail`);
    }
});

test('a missing review count is not read as zero reviews', () => {
    const result = listingSignals(fixture('paris_final.html'), 'https://www.airbnb.com/rooms/51234567');
    assert.ok(!result.codes.includes('no_reviews'));
});

test('a cheap night with no stated area average is not flagged', () => {
    const html = `<html><body><h1>Stay</h1>
        <div data-testid="price-nightly">$40.00 per night</div>
        <p>2 guests</p></body></html>`;
    const result = listingSignals(html, 'https://www.airbnb.com/rooms/1');
    assert.deepStrictEqual(result.codes, []);
});

// --- no network, no keys ------------------------------------------------------------------

console.log('\nhygiene');

test('tokens.js exports the agreed surface and nothing else', () => {
    assert.deepStrictEqual(Object.keys(tokensModule).sort(), [
        'ExtractError',
        'TokenError',
        'compareTokens',
        'createFinalToken',
        'createInitialToken',
        'editToken',
        'listingSignals',
        'signToken',
        'verifyToken'
    ]);
});

test('the fraud module pulls in nothing that talks to the network', () => {
    const sources = ['extract.js', 'sign.js', 'signals.js', 'tokens.js']
        .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
        .join('\n');
    for (const banned of [/\bfetch\s*\(/, /require\(['"](?:https?|net|dns)['"]\)/, /\baxios\b/, /API_KEY/]) {
        assert.ok(!banned.test(sources), `found ${banned} in the fraud module`);
    }
});

const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length > 0) {
    process.exitCode = 1;
}

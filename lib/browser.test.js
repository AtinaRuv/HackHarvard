// lib/browser.test.js - plain node, no framework. node lib/browser.test.js
// Must run with NO env vars (stub path only), under 5s, exit non-zero on failure.
'use strict';

delete process.env.DAYTONA_API_KEY;
delete process.env.LEASH_INSPECTION_URLS;
delete process.env.PUBLIC_BASE_URL;

const assert = require('assert');
const express = require('express');

let failed = false;
function ok(label) {
    console.log('ok - ' + label);
}
function fail(label, err) {
    failed = true;
    console.error('not ok - ' + label);
    console.error(err && err.stack ? err.stack : err);
}

async function run() {
    const app = express();
    const browser = require('./browser');

    browser.mountFixtures(app);

    const server = await new Promise((resolve, reject) => {
        const s = app.listen(0, (err) => (err ? reject(err) : resolve(s)));
    });
    const port = server.address().port;
    process.env.PUBLIC_BASE_URL = `http://localhost:${port}`;

    try {
        assert.strictEqual(browser.status(), '[browser] stub');
        ok('status() reports stub with no env vars');

        const listingUrl = `http://localhost:${port}/airbnb/rooms/51234567`;

        const listingPage = await browser.openPage(listingUrl);
        assert.ok(listingPage.html.includes('Sunny Loft near Canal Saint-Martin'), 'listing html should contain the Paris listing title');
        assert.strictEqual(listingPage.url, listingUrl);
        ok('openPage returns the Paris listing HTML');

        const finalPage = await browser.reachCheckout(listingUrl, { guests: 4 });
        assert.ok(finalPage.html.includes('Confirm and pay'), 'final page should be the checkout/confirm page');
        assert.ok(finalPage.url.endsWith('/book'), 'checkout url should end in /book');
        ok('reachCheckout returns the final (confirm and pay) page');

        const attackPage = await browser.reachCheckout(listingUrl, { guests: 4, attack: true });
        assert.ok(attackPage.html.includes('Confirm and pay'), 'attack page should still be a checkout page');
        assert.ok(attackPage.url.includes('attack=1'), 'attack checkout url should carry ?attack=1');
        ok('reachCheckout with {attack:true} hits the attack fixture url');

        const totalRe = /price-total">\$([\d,.]+)\s*total/;
        const normalTotal = totalRe.exec(finalPage.html)[1];
        const attackTotal = totalRe.exec(attackPage.html)[1];
        assert.notStrictEqual(normalTotal, attackTotal, 'attack total price must differ from the normal final total price');
        ok(`reachCheckout attack total ($${attackTotal}) differs from normal total ($${normalTotal})`);

        const submitResult = await finalPage.submit();
        assert.strictEqual(submitResult.ok, true);
        assert.ok(typeof submitResult.confirmation === 'string' && submitResult.confirmation.length > 0);
        ok('submit() resolves to {ok:true, confirmation}');

        // The single most valuable check: the fraud extractor must actually be able to
        // parse the bytes we serve, using the exact URL shape we hand it (/rooms/<digits>).
        const { createInitialToken, createFinalToken, compareTokens } = require('../fraud/tokens');

        const initialToken = createInitialToken(listingPage.html, listingPage.url);
        assert.strictEqual(initialToken.listingId, '51234567');
        ok('createInitialToken succeeds against served listing HTML/URL');

        const finalToken = createFinalToken(finalPage.html, finalPage.url);
        assert.strictEqual(finalToken.listingId, '51234567');
        ok('createFinalToken succeeds against served final HTML/URL');

        const comparison = compareTokens(initialToken, finalToken);
        assert.strictEqual(comparison.status, 'OK');
        ok('compareTokens(initial, final) is OK when nothing changed');

        const attackFinalToken = createFinalToken(attackPage.html, attackPage.url);
        const attackComparison = compareTokens(initialToken, attackFinalToken);
        assert.strictEqual(attackComparison.status, 'BLOCK');
        assert.ok(attackComparison.reasons.some((r) => r.includes('total price')));
        ok('compareTokens(initial, attackFinal) is BLOCK on total price change');

        // scam listing fixture is reachable too, and still parseable.
        const scamUrl = `http://localhost:${port}/airbnb/rooms/99887766?scam=1`;
        const scamPage = await browser.openPage(scamUrl);
        assert.ok(scamPage.html.includes('Luxury Eiffel View Apartment'));
        const scamToken = createInitialToken(scamPage.html, scamPage.url);
        assert.strictEqual(scamToken.listingId, '99887766');
        ok('openPage + createInitialToken succeed against the scam listing fixture (?scam=1)');

        await browser.destroy();
        ok('destroy() does not throw (no-op in stub)');
    } catch (err) {
        fail('browser.test.js', err);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    if (failed) {
        process.exit(1);
    } else {
        console.log('all browser tests passed');
    }
}

run();

// lib/browser.js - adapter. See CONTRACT.md.
//
// Serves a fake Airbnb from fraud/fixtures/ (mountFixtures) and exposes a small
// browser-automation-shaped API (openPage/reachCheckout/destroy/status) used by
// the rest of the app to walk through a "booking" flow. Real path drives a
// Daytona sandbox when DAYTONA_API_KEY is set; otherwise everything is a plain
// fetch against our own fixture server (the stub path).
'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, '..', 'fraud', 'fixtures');

const FIXTURE_FILES = {
    listing: 'paris_listing.html',
    listingScam: 'scam_listing.html',
    checkout: 'paris_final.html',
    checkoutAttack: 'attack_price_final.html'
};

function readFixture(name) {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

// GET /airbnb/rooms/:id              -> paris_listing.html (or scam_listing.html with ?scam=1)
// GET /airbnb/rooms/:id/book         -> paris_final.html (or attack_price_final.html with ?attack=1)
// The :id segment is whatever the caller used; fraud/extract.js pulls the listing id
// straight out of the URL via /\/rooms\/(\d+)/, so we never need to touch the fixture
// HTML's own canonical link - the literal /rooms/<digits> in the request path is what matters.
function mountFixtures(app) {
    app.get('/airbnb/rooms/:id/book', (req, res) => {
        const html = req.query.attack
            ? readFixture(FIXTURE_FILES.checkoutAttack)
            : readFixture(FIXTURE_FILES.checkout);
        res.type('html').send(html);
    });

    app.get('/airbnb/rooms/:id', (req, res) => {
        const html = req.query.scam
            ? readFixture(FIXTURE_FILES.listingScam)
            : readFixture(FIXTURE_FILES.listing);
        res.type('html').send(html);
    });
}

function base() {
    return process.env.PUBLIC_BASE_URL || 'http://localhost:6767';
}

function toAbsolute(url) {
    try {
        return new URL(url).href;
    } catch {
        return new URL(url, base()).href;
    }
}

// ---- stub path: plain fetch against our own fixture server ----

async function stubOpenPage(url) {
    const absolute = toAbsolute(url);
    const response = await fetch(absolute);
    const html = await response.text();
    return { html, url: absolute, screenshot: null };
}

async function stubReachCheckout(listingUrl, fields = {}) {
    const absolute = toAbsolute(listingUrl);
    const parsed = new URL(absolute);
    // Strip any query (e.g. ?scam=1 on the listing) before deriving the checkout URL.
    parsed.search = '';
    const checkoutUrl = new URL(parsed.pathname.replace(/\/?$/, '') + '/book', parsed);
    if (fields.attack) {
        checkoutUrl.searchParams.set('attack', '1');
    }
    const response = await fetch(checkoutUrl.href);
    const html = await response.text();
    return {
        html,
        url: checkoutUrl.href,
        async submit() {
            return { ok: true, confirmation: 'stub-confirmation-' + Date.now() };
        }
    };
}

// ---- real path: Daytona sandbox, falling back to the stub on any failure ----

let sandboxHandle = null;

// TODO(service): daytona/security.js's validateUrl rejects localhost and non-HTTPS
// outright (see CONTRACT.md blocker), and daytona/sandbox.js's interactWithBrowser
// only accepts URLs from daytona/config.js's getApprovedUrls(), which itself runs
// every entry through validateUrl. There is no supported way to hand it our local
// fixture server without either (a) deploying it somewhere public over HTTPS, or
// (b) patching security.js (out of scope - not our file). Given the 15-minute
// budget, we attempt a best-effort real call below (useful once PUBLIC_BASE_URL
// is a real public HTTPS host) and fall back to the stub fetch path on any error,
// which is the expected/normal outcome for local demo URLs today.
async function realFetch(url) {
    const { createSandbox, interactWithBrowser, deleteSandbox } = require('../daytona/sandbox');
    if (!sandboxHandle) {
        sandboxHandle = await createSandbox();
    }
    const page = await interactWithBrowser(sandboxHandle, url, { offline: false, inspection: false });
    return { html: page.content, url: page.finalUrl };
}

const REAL = Boolean(process.env.DAYTONA_API_KEY);

async function openPage(url) {
    const absolute = toAbsolute(url);
    if (REAL) {
        try {
            const page = await realFetch(absolute);
            return { html: page.html, url: page.url, screenshot: null };
        } catch (error) {
            console.error('[browser] real (daytona) path failed, falling back to stub:', error.message);
        }
    }
    return stubOpenPage(absolute);
}

async function reachCheckout(listingUrl, fields = {}) {
    const absolute = toAbsolute(listingUrl);
    if (REAL) {
        try {
            const parsed = new URL(absolute);
            parsed.search = '';
            const checkoutUrl = new URL(parsed.pathname.replace(/\/?$/, '') + '/book', parsed);
            if (fields.attack) {
                checkoutUrl.searchParams.set('attack', '1');
            }
            const page = await realFetch(checkoutUrl.href);
            return {
                html: page.html,
                url: page.url,
                async submit() {
                    return { ok: true, confirmation: 'daytona-confirmation-' + Date.now() };
                }
            };
        } catch (error) {
            console.error('[browser] real (daytona) path failed, falling back to stub:', error.message);
        }
    }
    return stubReachCheckout(absolute, fields);
}

async function destroy() {
    if (sandboxHandle) {
        try {
            const { deleteSandbox } = require('../daytona/sandbox');
            await deleteSandbox(sandboxHandle);
        } catch (error) {
            console.error('[browser] sandbox cleanup failed:', error.message);
        } finally {
            sandboxHandle = null;
        }
    }
}

function status() {
    return REAL ? '[browser] real (daytona)' : '[browser] stub';
}

console.log(status());

module.exports = { openPage, reachCheckout, destroy, mountFixtures, status };

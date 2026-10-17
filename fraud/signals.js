const cheerio = require('cheerio');

// Scam heuristics that read a listing page on its own, before any booking token exists.
// Everything here is local string matching: no model, no network, no keys.

const PAYMENT_RAILS = [
    /\bwire transfer\b/i,
    /\bbank transfer\b/i,
    /\bzelle\b/i,
    /\bvenmo\b/i,
    /\bcash app\b/i,
    /\bwestern union\b/i,
    /\bmoneygram\b/i,
    /\bgift cards?\b/i,
    /\bbitcoin\b|\bcrypto(?:currency)?\b|\busdt\b/i,
    /\bpay (?:the host |the owner )?directly\b/i,
    /\bskip the platform fees?\b/i,
    /\boff[- ]platform\b/i
];

const JOINED = /joined\s+(?:about\s+)?(\d{1,3})\s*(day|week|month|year)s?\s+ago/i;
const NO_REVIEWS = /\bno reviews?(?: yet)?\b/i;
const REVIEW_COUNT = /\b([\d,]+)\s+reviews?\b/i;
const NIGHTLY = /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per night|\/\s*night|a night|night)/i;
const AREA_AVERAGE = /average nightly[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i;

// A host younger than this is "new". Scam listings are typically days or weeks old;
// a genuine host who joined last spring should not trip the check.
const NEW_HOST_DAYS = 180;
const DAYS_PER = { day: 1, week: 7, month: 30, year: 365 };

// Below this fraction of the area average the price is implausible rather than a bargain.
const PRICE_TOO_GOOD_RATIO = 0.5;

// Emitted in this order so the UI always lists signals the same way.
const CODES = ['off_platform', 'off_platform_payment', 'no_reviews', 'new_host', 'price_too_good'];

function hostname(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

// True for airbnb.com and its country domains (airbnb.co.uk, airbnb.fr), false for
// lookalikes like airbnb-deals-paris.com or airbnb.com.verify-booking.net. Suffix labels
// are short and alphabetic, so anything longer sitting after "airbnb" means the real
// registrable domain belongs to somebody else.
function isAirbnbHost(host) {
    const labels = host.split('.');
    const index = labels.indexOf('airbnb');
    if (index === -1) {
        return false;
    }
    const suffix = labels.slice(index + 1);
    return suffix.length > 0 && suffix.every((label) => /^[a-z]{2,3}$/.test(label));
}

function toNumber(raw) {
    return Number(raw.replace(/,/g, ''));
}

function checkOffPlatform(host) {
    if (!host || isAirbnbHost(host)) {
        return null;
    }
    return {
        code: 'off_platform',
        detail: host
            ? `the page is served from ${host}, not an Airbnb domain`
            : 'the page has no resolvable host'
    };
}

function checkPaymentRails(text) {
    const hit = PAYMENT_RAILS.find((rail) => rail.test(text));
    if (!hit) {
        return null;
    }
    const match = hit.exec(text);
    return {
        code: 'off_platform_payment',
        detail: `the page asks for payment outside Airbnb ("${match[0]}")`
    };
}

function checkReviews($, text) {
    const source = $('[data-testid="review-count"]').first().text() || text;
    if (NO_REVIEWS.test(source)) {
        return { code: 'no_reviews', detail: 'the listing has no reviews' };
    }
    const count = REVIEW_COUNT.exec(source);
    // An absent review element proves nothing, so only an explicit zero counts.
    if (count && toNumber(count[1]) === 0) {
        return { code: 'no_reviews', detail: 'the listing has no reviews' };
    }
    return null;
}

function checkHostAge($, text) {
    const source = $('[data-testid="host-joined"]').first().text() || text;
    const joined = JOINED.exec(source);
    if (!joined) {
        return null;
    }
    const days = Number(joined[1]) * DAYS_PER[joined[2].toLowerCase()];
    if (days >= NEW_HOST_DAYS) {
        return null;
    }
    return { code: 'new_host', detail: `the host joined ${joined[1]} ${joined[2]}s ago` };
}

function checkPrice($, text) {
    const nightlyText = $('[data-testid="price-nightly"]').first().text();
    const averageText = $('[data-testid="area-average"]').first().text();
    const nightly = NIGHTLY.exec(nightlyText || text);
    const average = AREA_AVERAGE.exec(averageText || text);
    // Without a stated area average there is nothing to compare against, so stay quiet
    // rather than guess at what a night in this neighbourhood ought to cost.
    if (!nightly || !average) {
        return null;
    }
    const asked = toNumber(nightly[1]);
    const typical = toNumber(average[1]);
    if (!typical || asked >= typical * PRICE_TOO_GOOD_RATIO) {
        return null;
    }
    const percent = Math.round((asked / typical) * 100);
    return {
        code: 'price_too_good',
        detail: `$${asked} a night is ${percent}% of the $${typical} area average`
    };
}

function scanListing(html, url) {
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const found = [
        checkOffPlatform(hostname(url)),
        checkPaymentRails(text),
        checkReviews($, text),
        checkHostAge($, text),
        checkPrice($, text)
    ].filter(Boolean);
    return {
        status: found.length > 0 ? 'WARN' : 'OK',
        codes: found.map((signal) => signal.code),
        signals: found
    };
}

module.exports = { scanListing, isAirbnbHost, CODES };

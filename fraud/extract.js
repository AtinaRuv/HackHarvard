const cheerio = require('cheerio');

const ROOM_ID = /\/rooms\/(\d+)/;
const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const ISO_PAIR = /\b(\d{4}-\d{2}-\d{2})\b[\s\S]{0,60}?\b(\d{4}-\d{2}-\d{2})\b/;
const FULL_RANGE = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\s*[-–—]\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/;
const SAME_MONTH_RANGE = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-–—]\s*(\d{1,2}),?\s+(\d{4})/;

class ExtractError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ExtractError';
    }
}

function findListingId(url, $) {
    // The URL comes from the sandbox that actually drove the browser, the page body does not.
    // A swapped listing can print any id it likes in its own markup, so the URL wins.
    const fromUrl = ROOM_ID.exec(url || '');
    if (fromUrl) {
        return fromUrl[1];
    }
    const fromCanonical = ROOM_ID.exec($('link[rel="canonical"]').attr('href') || '');
    return fromCanonical ? fromCanonical[1] : null;
}

function isoDate(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthNumber(name) {
    const month = MONTHS[name.slice(0, 3).toLowerCase()];
    if (!month) {
        throw new ExtractError(`unrecognized month name "${name}"`);
    }
    return month;
}

function parseDateRange(text) {
    const iso = ISO_PAIR.exec(text);
    if (iso) {
        return { checkIn: iso[1], checkOut: iso[2] };
    }
    const full = FULL_RANGE.exec(text);
    if (full) {
        return {
            checkIn: isoDate(full[3], monthNumber(full[1]), full[2]),
            checkOut: isoDate(full[6], monthNumber(full[4]), full[5])
        };
    }
    const sameMonth = SAME_MONTH_RANGE.exec(text);
    if (sameMonth) {
        const month = monthNumber(sameMonth[1]);
        return {
            checkIn: isoDate(sameMonth[4], month, sameMonth[2]),
            checkOut: isoDate(sameMonth[4], month, sameMonth[3])
        };
    }
    return null;
}

function extractDates($, text) {
    const checkIn = $('[data-testid="checkin-date"]').first().attr('data-date');
    const checkOut = $('[data-testid="checkout-date"]').first().attr('data-date');
    if (checkIn && checkOut) {
        return { checkIn, checkOut };
    }
    const range = parseDateRange(text);
    if (!range) {
        throw new ExtractError('checkIn and checkOut not found');
    }
    return range;
}

function parsePrice(raw) {
    return Number(raw.replace(/,/g, ''));
}

function extractTotal($, text) {
    const labelled = /\$\s*([\d,]+(?:\.\d{2})?)/.exec($('[data-testid="price-total"]').first().text());
    if (labelled) {
        return parsePrice(labelled[1]);
    }
    const fromText = /\$\s*([\d,]+(?:\.\d{2})?)\s*total/i.exec(text);
    if (!fromText) {
        throw new ExtractError('totalPrice not found');
    }
    return parsePrice(fromText[1]);
}

function extractGuests($, text) {
    const source = $('[data-testid="guest-count"]').first().text() || text;
    // Capped at two digits so a nearby year ("Nov 5 - 9, 2026 Guests: 2") cannot be read as a count.
    const guests = /\b(\d{1,2})\s*guests?\b/i.exec(source);
    if (!guests) {
        throw new ExtractError('guests not found');
    }
    return Number(guests[1]);
}

function extractTitle($) {
    const title = $('[data-testid="listing-title"]').first().text().trim() || $('h1').first().text().trim();
    if (!title) {
        throw new ExtractError('title not found');
    }
    return title;
}

function extractHost($, text) {
    const labelled = $('[data-testid="host-name"]').first().text().trim();
    const host = labelled || (/hosted by\s+([A-Za-z][A-Za-z'’-]{0,30})/i.exec(text) || [])[1] || '';
    const name = host.replace(/^hosted by\s+/i, '').trim();
    return name || null;
}

function extract(html, url, source) {
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const listingId = findListingId(url, $);
    if (!listingId) {
        throw new ExtractError('listingId not found in url or canonical link');
    }
    const dates = extractDates($, text);
    return {
        listingId,
        title: extractTitle($),
        checkIn: dates.checkIn,
        checkOut: dates.checkOut,
        guests: extractGuests($, text),
        totalPrice: extractTotal($, text),
        currency: 'USD',
        host: extractHost($, text),
        source,
        createdAt: new Date().toISOString(),
        sig: null
    };
}

module.exports = { extract, findListingId, ExtractError };

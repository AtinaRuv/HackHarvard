const { extract, ExtractError } = require('./extract');
const { signToken, verifyToken, CANONICAL_FIELDS } = require('./sign');
const { scanListing } = require('./signals');

// A booking token is what the group approved. It is minted from the listing page, signed, and
// then checked against whatever the checkout page finally says. If the two disagree on any
// signed field, the payment is blocked and a human looks at it.

// The listing id is deliberately not editable: changing which home you are booking is a new
// approval, not an edit to an existing one.
const EDITABLE_FIELDS = CANONICAL_FIELDS.filter((field) => field !== 'listingId');

const LABELS = {
    checkIn: 'check-in',
    checkOut: 'check-out',
    currency: 'currency',
    guests: 'guests',
    listingId: 'listing',
    totalPrice: 'total price'
};

class TokenError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TokenError';
    }
}

// What the group is approving, read off the listing page.
function createInitialToken(html, url) {
    return signToken(extract(html, url, 'listing'));
}

// What checkout is actually about to charge, read off the final page.
function createFinalToken(html, url) {
    return signToken(extract(html, url, 'checkout'));
}

// Unknown keys are ignored so a caller can pass a whole form body, but an attempt to edit a
// locked field is refused loudly rather than silently dropped.
function editToken(token, edit) {
    const changed = [];
    const ignored = [];
    const next = { ...token };
    for (const [field, value] of Object.entries(edit || {})) {
        if (!EDITABLE_FIELDS.includes(field)) {
            if (CANONICAL_FIELDS.includes(field)) {
                throw new TokenError(`${field} cannot be edited, mint a new token instead`);
            }
            ignored.push(field);
            continue;
        }
        if (next[field] !== value) {
            next[field] = value;
            changed.push(field);
        }
    }
    // Re-signed over the edited values, so the approval the group sees is the one checkout meets.
    return { token: signToken(next), changed, ignored };
}

function describe(field, before, after) {
    return `${LABELS[field]} changed from ${before} to ${after}`;
}

// Returns the signed fields that disagree. "signature" comes first when either side fails to
// verify, then field differences in canonical order, so the output is stable to assert on.
function compareTokens(initial, final) {
    const fields = [];
    const reasons = [];
    if (!verifyToken(initial) || !verifyToken(final)) {
        fields.push('signature');
        reasons.push('the token signature does not match its contents');
    }
    for (const field of CANONICAL_FIELDS) {
        if (initial[field] !== final[field]) {
            fields.push(field);
            reasons.push(describe(field, initial[field], final[field]));
        }
    }
    return { status: fields.length > 0 ? 'BLOCK' : 'OK', fields, reasons };
}

// Scam heuristics for a listing page on its own, before any token exists.
const listingSignals = scanListing;

// The seven calls a caller needs, plus the error types so they can be caught by class
// rather than by message. ExtractError is re-exported from extract.js, where it is thrown.
module.exports = {
    createInitialToken,
    createFinalToken,
    editToken,
    compareTokens,
    signToken,
    verifyToken,
    listingSignals,
    TokenError,
    ExtractError
};

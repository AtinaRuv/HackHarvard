const crypto = require('crypto');

const CANONICAL_FIELDS = ['checkIn', 'checkOut', 'currency', 'guests', 'listingId', 'totalPrice'];
const DEV_SECRET = 'fraud-dev-secret-not-for-production';

let warned = false;

function secret() {
    if (process.env.TOKEN_SIGNING_SECRET) {
        return process.env.TOKEN_SIGNING_SECRET;
    }
    if (!warned) {
        console.warn('TOKEN_SIGNING_SECRET is not set, falling back to the development secret');
        warned = true;
    }
    return DEV_SECRET;
}

// Only the fields the group actually agreed on are signed. Title, host and createdAt are
// descriptive, so re-rendering a page with a reworded title must not invalidate an approval.
function canonicalize(token) {
    const signed = {};
    for (const field of CANONICAL_FIELDS) {
        signed[field] = token[field];
    }
    return JSON.stringify(signed);
}

function digest(token) {
    return crypto.createHmac('sha256', secret()).update(canonicalize(token)).digest('hex');
}

function signToken(token) {
    return { ...token, sig: digest(token) };
}

function verifyToken(token) {
    if (!token || typeof token.sig !== 'string' || token.sig.length === 0) {
        return false;
    }
    const expected = Buffer.from(digest(token), 'utf8');
    const actual = Buffer.from(token.sig, 'utf8');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { signToken, verifyToken, CANONICAL_FIELDS };

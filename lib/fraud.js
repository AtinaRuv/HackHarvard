// lib/fraud.js - thin wrapper over fraud/tokens.js. No logic of its own.
// See CONTRACT.md. fraud/ is done and tested (node fraud/test_tokens.js, 33 passing).
const tokens = require('../fraud/tokens');

// Scam heuristics on a listing page, before any token exists.
function signals(html, url) {
    return tokens.listingSignals(html, url);
}

// Mint the token the group approves, off the checkout page, and hang it on the group.
function approve(group, checkoutHtml, url) {
    const token = tokens.createInitialToken(checkoutHtml, url);
    if (group) group.approvedToken = token;
    return token;
}

// Re-sign the approved token with the group's changes (guests, dates, price).
function amend(group, changes) {
    const { token } = tokens.editToken(group.approvedToken, changes);
    group.approvedToken = token;
    return token;
}

// The gate: what the final page says, against what the group approved.
function clear(group, finalHtml, url) {
    const final = tokens.createFinalToken(finalHtml, url);
    return tokens.compareTokens(group.approvedToken, final);
}

function status() { return '[fraud] real'; }
console.log(status());

module.exports = { signals, approve, amend, clear, status, TokenError: tokens.TokenError, ExtractError: tokens.ExtractError };

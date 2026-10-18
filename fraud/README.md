# Booking tokens

A booking token is what the group approved: minted from the listing page, signed, then checked
against what the checkout page finally says. Any disagreement on a signed field blocks the
payment. Everything is local — HTML parsing and HMAC, no model, no network, no API keys.

```js
const scan = listingSignals(listingHtml, listingUrl);          // { status, codes, signals }
const token = createInitialToken(listingHtml, listingUrl);
const { token: approved } = editToken(token, { guests: 5 });   // re-signs
const final = createFinalToken(checkoutHtml, checkoutUrl);
const result = compareTokens(approved, final);
if (result.status === 'BLOCK') console.log(result.reasons);    // ["total price changed from 900 to 1240"]
```

Also exported: `signToken`, `verifyToken`, `TokenError`, `ExtractError`. **Signed fields:**
`checkIn checkOut currency guests listingId totalPrice`. `title`, `host`, `source` and
`createdAt` ride along unsigned, so a reworded page cannot invalidate an approval. The listing
id comes from the sandbox URL, never the page body. All of them except `listingId` are
editable (a different home is a new approval, not an edit); unknown keys are ignored.
`compareTokens` puts `"signature"` first when either side fails to verify, then differing
fields in canonical order. Signals (`WARN`): `off_platform`, `off_platform_payment`,
`no_reviews`, `new_host`, `price_too_good` — each needs positive evidence, absence never fires.

`TOKEN_SIGNING_SECRET` comes from the env; the dev fallback warns. Tests: `npm test`, 33 cases.

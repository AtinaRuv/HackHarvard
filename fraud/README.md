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
fields in canonical order.

The listing scanner returns `decision`, `signals`, `observations`, and `coverage`.
`BLOCK` requires an untrusted origin or a contextual request to pay outside Airbnb.
Every actionable signal includes its source and a short evidence excerpt. Official
gift-card navigation and negated safety advice are not payment requests.

`no_reviews`, `new_host`, and `price_too_good` are informational observations,
not fraud votes; any number of these alone still yields `PROCEED`. Reviews are
read only from listing-specific review elements. Hidden hydration strings and
missing counts are not zero reviews. Missing or conflicting evidence is recorded
in `coverage`. Browser challenges yield `INCONCLUSIVE`, not a fraud accusation.
`PROCEED` means no actionable evidence was found, not a guarantee about the host.
The booking worker still independently verifies the signed amount, dates, and
payment destination before spending.

`TOKEN_SIGNING_SECRET` comes from the env; the dev fallback warns. Tests: `npm test`, 33 cases.

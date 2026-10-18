# Runbook

## Start it

```
npm install
npm start
```

Then open **http://localhost:6767/demo**.

The startup banner tells you what is real and what is stubbed:

```
[chat] stub            (or: real (photon))
[browser] stub         (or: real (daytona))
[bank] stub            (or: real (nessie))
[payments] stub        (or: real (stripe))
[fraud] real           (always real - no API, local HMAC only)
[demo] ready
```

Everything runs with **zero env vars**. Each lane flips to its real API only when its key is
present, and falls back to the stub on any error rather than taking the demo down with it.

## What a judge does

1. Open `/demo` on the laptop. Three columns: chat, agent, ledger.
2. Press **Run happy path**. The bot greets, opens the listing, quotes the total and the
   per-person share, opens a pot, and posts a pay link per member.
3. Tap a pay link (or click it in the chat column). One big Pay button. Tap it.
4. The ledger moves: that member flips to paid and the balance goes up.
5. When everyone has paid, the bot re-opens the checkout page, compares it to the signed
   token the group approved, withdraws, and confirms the booking.
6. Press **Run attack**. Same flow, but the final page has been tampered with. The bot
   blocks, prints the diff in plain words, and the money stays in the pot.
7. Press **Scam listing check**. The bot refuses the listing before anyone pays a cent.
8. Type in the chat box at any time. It posts to `POST /webhook/photon`, the same endpoint
   Photon delivers real SMS to, so typing is identical to texting. Try:
   - a listing link containing `/rooms/<digits>`
   - `5 of us` to change the headcount
   - `ok` to approve

## Pay links on a phone

Pay links default to `http://localhost:6767`, which a phone cannot reach. For the
phone demo, set the laptop's LAN address before starting:

```
APP_BASE_URL=http://192.168.25.228:6767 PUBLIC_BASE_URL=http://192.168.25.228:6767 npm start
```

Then the pay links in chat point at the laptop and the judge's phone can open them over wifi.

## Routes

| route | what it does |
|---|---|
| `GET /demo` | the judge-facing page |
| `GET /events/:groupId` | SSE event stream for that group |
| `POST /run/:groupId` | run the flow. `?attack=1`, `?scam=1` |
| `GET /state/:groupId` | the whole group state as JSON, for scripted checks |
| `POST /webhook/photon` | inbound message. Photon SMS and the demo chat box both land here |
| `GET /pay/:groupId/:member` | the local pay page |
| `POST /pay/:groupId/:member` | marks it paid, feeds a Stripe-shaped event to the webhook |
| `POST /webhook/stripe` | Stripe webhook, idempotent on `event.id` |
| `GET /airbnb/rooms/:id` | the fake Airbnb listing (`?scam=1` for the scam fixture) |
| `GET /airbnb/rooms/:id/book` | the checkout page (`?attack=1` for the tampered one) |

## Tests

```
npm test            # fraud token suite, 33 cases
npm run test:lib    # the five adapter smoke tests, no env vars, a few seconds
```

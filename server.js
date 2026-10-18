// server.js - mounts every adapter, the demo page, and the flow routes. Port 6767.
require('dotenv/config');
const os = require('os');
const path = require('path');
const express = require('express');

const PORT = Number(process.env.PORT || 6767);

// A judge taps the pay link on their own phone, where "localhost" is the phone.
// So the links have to carry this laptop's address on the wifi, not localhost.
// Set APP_BASE_URL yourself to override; otherwise we work it out.
function lanAddress() {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === 'IPv4' && !a.internal) return a.address;
        }
    }
    return 'localhost';
}
const BASE = `http://${lanAddress()}:${PORT}`;
// .env may pin these to a stale host or port, which silently breaks the phone demo.
if (!process.env.APP_BASE_URL || /localhost|127\.0\.0\.1/.test(process.env.APP_BASE_URL)) {
    process.env.APP_BASE_URL = BASE;
}
if (!process.env.PUBLIC_BASE_URL) process.env.PUBLIC_BASE_URL = BASE;

const chat = require('./lib/chat');
const browser = require('./lib/browser');
const bank = require('./lib/bank');
const payments = require('./lib/payments');
const fraud = require('./lib/fraud');
const demo = require('./lib/demo');
const flow = require('./lib/flow');

const app = express();

// Stripe signature verification needs the untouched bytes, before JSON parsing.
app.use('/webhook/stripe', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ——— adapters ———————————————————————————————————————————————————————————————
chat.mountWebhook(app);        // POST /webhook/photon
browser.mountFixtures(app);    // GET /airbnb/rooms/:id[/book]
payments.mountRoutes(app);     // POST /webhook/stripe, GET+POST /pay/:groupId/:member
demo.mount(app);               // GET /demo, GET /events/:groupId
flow.wire();                   // chat.onInbound -> flow, payments.onPaid -> flow

// ——— teammates' existing routes, kept ——————————————————————————————————————
try {
    app.use('/payments', require('./stripe/routes'));
} catch (e) {
    console.log('[stripe] legacy /payments routes not mounted:', e.message);
}

// ——— flow routes ————————————————————————————————————————————————————————————
app.post('/run/:groupId', async (req, res) => {
    const opts = { attack: !!req.query.attack, scam: !!req.query.scam };
    res.json({ ok: true, groupId: req.params.groupId, ...opts });
    flow.runFlow(req.params.groupId, opts).catch((e) => console.error('[flow]', e.message));
});
app.get('/run/:groupId', (req, res) => {
    const opts = { attack: !!req.query.attack, scam: !!req.query.scam };
    res.json({ ok: true, groupId: req.params.groupId, ...opts });
    flow.runFlow(req.params.groupId, opts).catch((e) => console.error('[flow]', e.message));
});

// The group's state as JSON, for scripted verification.
app.get('/state/:groupId', async (req, res) => {
    const g = flow.getGroup(req.params.groupId);
    res.json({
        id: g.id,
        state: g.state,
        listingUrl: g.listingUrl,
        accountId: g.accountId,
        balanceCents: g.accountId ? await bank.balance(g.accountId) : 0,
        members: g.members.map((m) => ({ name: m.name, share: m.share, paid: !!m.paid, payUrl: m.payUrl })),
        approvedToken: g.approvedToken,
        log: g.log
    });
});

app.get('/', (req, res) => res.redirect('/demo'));
app.get('/ping', (req, res) => res.send('pong'));
app.post('/ping', (req, res) => res.send('pong'));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`  demo page   ${BASE}/demo`);
    console.log(`  pay links   ${process.env.APP_BASE_URL}/pay/...  (open these on a phone)`);
});

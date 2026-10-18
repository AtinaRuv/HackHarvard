// server.js - mounts every adapter, the demo page, and the flow routes. Port 6767.
require('dotenv/config');
const path = require('path');
const express = require('express');

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

const PORT = Number(process.env.PORT || 6767);
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}  ->  http://localhost:${PORT}/demo`);
});

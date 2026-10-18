// lib/flow.js - the orchestrator. Holds the groups, runs the booking flow,
// and routes every inbound message (Photon SMS or the demo input box) through
// one code path. Regex only, no model calls anywhere.
const chat = require('./chat');
const browser = require('./browser');
const bank = require('./bank');
const payments = require('./payments');
const fraud = require('./fraud');
const demo = require('./demo');

const PAUSE = Number(process.env.FLOW_PAUSE_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_LISTING = () =>
    (process.env.PUBLIC_BASE_URL || 'http://localhost:6767') + '/airbnb/rooms/12345';

// ——— groups ————————————————————————————————————————————————————————————————

const groups = new Map();

function getGroup(id) {
    if (!groups.has(id)) {
        groups.set(id, {
            id,
            members: [],
            listingUrl: null,
            approvedToken: null,
            accountId: null,
            state: 'new',
            log: []
        });
    }
    return groups.get(id);
}

function setState(g, state) {
    g.state = state;
    demo.publish(g.id, { type: 'state', state });
}

// Every outgoing line goes to chat and to the demo page together.
function say(g, text) {
    g.log.push({ dir: 'out', text, ts: Date.now() });
    chat.send(g.id, text);
    demo.publish(g.id, { type: 'chat', dir: 'out', from: 'bot', text });
}

function step(g, text) {
    demo.publish(g.id, { type: 'step', text });
}

function dollars(cents) {
    return '$' + (cents / 100).toFixed(2);
}

async function pushLedger(g) {
    const balanceCents = g.accountId ? await bank.balance(g.accountId) : 0;
    demo.publish(g.id, {
        type: 'ledger',
        balanceCents,
        members: g.members.map((m) => ({ name: m.name, share: m.share, paid: !!m.paid })),
        total: g.approvedToken ? Math.round(Number(g.approvedToken.totalPrice) * 100) : 0
    });
}

function pushToken(g) {
    const t = g.approvedToken;
    if (!t) return;
    demo.publish(g.id, {
        type: 'token',
        fields: {
            listingId: t.listingId,
            checkIn: t.checkIn,
            checkOut: t.checkOut,
            guests: t.guests,
            totalPrice: t.totalPrice,
            currency: t.currency
        }
    });
}

function makeMembers(g, headcount) {
    const names = ['Ava', 'Ben', 'Chloe', 'Dan', 'Eli', 'Fay', 'Gus', 'Hana'];
    g.members = [];
    for (let i = 0; i < headcount; i++) {
        g.members.push({ name: names[i % names.length], share: 0, paid: false });
    }
}

// ——— the flow ——————————————————————————————————————————————————————————————

async function runFlow(groupId, opts = {}) {
    const g = getGroup(groupId);
    const attack = !!opts.attack;
    const scam = !!opts.scam;

    try {
        // 1. greet, unless they opened with the link and we are already past that.
        if (!g.listingUrl) {
            setState(g, 'greeting');
            say(g, 'Hi, I am the booking agent. Send me the listing link and how many of you are going.');
            await sleep(PAUSE);

            // Demo mode auto-answers. With real Photon, wait for the reply instead.
            if (opts.wait) {
                setState(g, 'awaiting_listing');
                return g;
            }
        }
        const listing = g.listingUrl || DEFAULT_LISTING() + (scam ? '?scam=1' : '');
        g.listingUrl = listing;
        const headcount = g.members.length || 3;
        makeMembers(g, headcount);
        if (!opts.wait) {
            demo.publish(g.id, { type: 'chat', dir: 'in', from: 'group', text: `${listing} — ${headcount} of us` });
        }
        await sleep(PAUSE);

        // 2. open the listing, scan it
        setState(g, 'scanning');
        step(g, 'Opening the listing page');
        const page = await browser.openPage(listing);
        demo.publish(g.id, { type: 'page', url: page.url });
        const scan = fraud.signals(page.html, page.url);
        step(g, `Scam signals: ${scan.status}`);
        // We serve the fixtures off localhost, so off_platform fires on every page here.
        // It is an artifact of the demo host, not evidence, so it warns but never blocks.
        const real = (scan.signals || []).filter((s) => s.code !== 'off_platform');
        const reasons = real.map((s) => s.detail || s.code);
        demo.publish(g.id, {
            type: 'verdict',
            status: real.length ? 'WARN' : 'OK',
            reasons: reasons.length ? reasons : ['listing looks clean']
        });
        if (real.length) {
            say(g, `Heads up, this listing looks off: ${reasons.join('; ')}.`);
            // Several independent signals at once is a scam, not a quirk. Stop there.
            if (real.length >= 2) {
                say(g, 'That is too many red flags. I am not booking this one.');
                setState(g, 'blocked');
                return g;
            }
        }
        await sleep(PAUSE);

        // 3. reach checkout, mint the approved token
        setState(g, 'quoting');
        step(g, 'Reaching the checkout page');
        const checkout = await browser.reachCheckout(listing, { guests: headcount });
        demo.publish(g.id, { type: 'page', url: checkout.url });
        fraud.approve(g, checkout.html, checkout.url);
        pushToken(g);
        const t = g.approvedToken;
        const totalCents = Math.round(Number(t.totalPrice) * 100);
        const shareCents = Math.round(totalCents / headcount);
        g.members.forEach((m) => { m.share = shareCents; });
        await pushLedger(g);
        say(g, `${t.checkIn} to ${t.checkOut}, ${t.guests} guests, ${dollars(totalCents)} total. That is ${dollars(shareCents)} each. Reply ok to lock it in.`);
        setState(g, 'awaiting_ok');
        if (opts.wait) return g;
        await sleep(PAUSE);
        return await confirm(g, { attack });
    } catch (err) {
        step(g, 'Error: ' + err.message);
        say(g, 'Something went wrong on my side: ' + err.message);
        setState(g, 'error');
        return g;
    }
}

// 4. the group said ok: open the pot and hand out pay links
async function confirm(g, opts = {}) {
    if (g.state === 'collecting' || g.state === 'settled') return g;
    setState(g, 'collecting');
    g._attack = !!opts.attack || !!g._attack;

    step(g, 'Opening the group account');
    g.accountId = await bank.createAccount(`group-${g.id}`);
    await pushLedger(g);
    await sleep(PAUSE);

    step(g, 'Creating a pay link per member');
    for (const m of g.members) {
        m.payUrl = await payments.createPayLink(g.id, m.name, m.share);
    }
    say(g, 'Pot is open. Everyone pay your share:');
    for (const m of g.members) {
        say(g, `${m.name}: ${dollars(m.share)} — ${m.payUrl}`);
    }
    await pushLedger(g);
    return g;
}

// 5 + 6. everyone paid: re-check the final page against what was approved
async function settle(g) {
    if (g.state === 'settling' || g.state === 'settled' || g.state === 'blocked') return g;
    setState(g, 'settling');
    try {
        step(g, 'Everyone paid. Re-opening the checkout page to confirm nothing moved.');
        say(g, 'Everyone has paid. Checking the final page before I send the money.');
        await sleep(PAUSE);

        const final = await browser.reachCheckout(g.listingUrl, { guests: g.members.length, attack: !!g._attack });
        demo.publish(g.id, { type: 'page', url: final.url });

        const verdict = fraud.clear(g, final.html, final.url);
        demo.publish(g.id, { type: 'verdict', status: verdict.status, reasons: verdict.reasons || [] });
        step(g, `Fraud check: ${verdict.status}`);
        await sleep(PAUSE);

        if (verdict.status !== 'OK') {
            say(g, 'Stop. The final page does not match what you approved:');
            for (const r of verdict.reasons) say(g, `- ${r}`);
            say(g, 'I have not sent any money. Your contributions are still in the pot.');
            setState(g, 'blocked');
            await pushLedger(g);
            return g;
        }

        const totalCents = Math.round(Number(g.approvedToken.totalPrice) * 100);
        await bank.withdraw(g.accountId, totalCents);
        await pushLedger(g);
        const res = await final.submit();
        step(g, 'Booking submitted: ' + (res.confirmation || 'ok'));
        say(g, `Booked. ${dollars(totalCents)} paid, confirmation ${res.confirmation || 'ok'}. Enjoy ${g.approvedToken.checkIn} to ${g.approvedToken.checkOut}. I am off, text me if anything changes.`);
        setState(g, 'settled');
        await pushLedger(g);
        return g;
    } catch (err) {
        step(g, 'Error while settling: ' + err.message);
        say(g, 'I could not confirm the final page, so I have not sent any money: ' + err.message);
        setState(g, 'blocked');
        return g;
    }
}

// ——— inbound messages, one code path for SMS and for the demo box ——————————

const URL_RE = /(https?:\/\/\S*\/rooms\/\d+\S*)/i;
const OK_RE = /\b(ok|okay|yes|yep|approve|approved|confirm)\b/i;
const HEADCOUNT_RE = /(\d+)\s*(people|guests|of us|pax)/i;
const DATES_RE = /(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/;

async function handleInbound({ from, groupId, text }) {
    const g = getGroup(groupId || 'demo');
    const body = String(text || '');
    g.log.push({ dir: 'in', from, text: body, ts: Date.now() });
    demo.publish(g.id, { type: 'chat', dir: 'in', from: from || 'you', text: body });

    const url = body.match(URL_RE);
    if (url) {
        g.listingUrl = url[1];
        say(g, 'Got the listing. Let me look at it.');
        return runFlow(g.id, { wait: true });
    }

    if (g.approvedToken) {
        const dates = body.match(DATES_RE);
        if (dates) {
            fraud.amend(g, { checkIn: dates[1], checkOut: dates[2] });
            pushToken(g);
            say(g, `Changed: ${dates[1]} to ${dates[2]}. Reply ok to lock it in.`);
            return g;
        }
        const head = body.match(HEADCOUNT_RE);
        if (head) {
            const n = Number(head[1]);
            fraud.amend(g, { guests: n });
            makeMembers(g, n);
            const totalCents = Math.round(Number(g.approvedToken.totalPrice) * 100);
            const shareCents = Math.round(totalCents / n);
            g.members.forEach((m) => { m.share = shareCents; });
            pushToken(g);
            await pushLedger(g);
            say(g, `Changed: ${n} guests, ${dollars(shareCents)} each. Reply ok to lock it in.`);
            return g;
        }
    }

    if (OK_RE.test(body)) {
        if (!g.approvedToken) {
            say(g, 'Send me the listing link first.');
            return g;
        }
        return confirm(g, {});
    }

    const head = body.match(HEADCOUNT_RE);
    if (head) {
        makeMembers(g, Number(head[1]));
        say(g, `Noted, ${head[1]} of you.`);
        return g;
    }

    say(g, 'Send me the listing link, or reply ok once I have quoted you.');
    return g;
}

// ——— payment callback ——————————————————————————————————————————————————————

async function handlePaid({ groupId, member, cents }) {
    const g = getGroup(groupId);
    const m = g.members.find((x) => x.name === member);
    if (!m) return;
    if (!g.accountId) g.accountId = await bank.createAccount(`group-${g.id}`);
    const res = await bank.deposit(g.accountId, cents, `${groupId}:${member}`);
    if (res.applied === false) return; // already counted, say nothing twice
    m.paid = true;
    say(g, `${member} paid ${dollars(cents)}.`);
    await pushLedger(g);
    const outstanding = g.members.filter((x) => !x.paid);
    if (outstanding.length === 0) {
        setTimeout(() => settle(g).catch(() => {}), PAUSE);
    } else {
        step(g, `Waiting on ${outstanding.map((x) => x.name).join(', ')}`);
    }
}

function wire() {
    chat.onInbound((msg) => { handleInbound(msg).catch((e) => console.error('[flow] inbound', e.message)); });
    payments.onPaid((p) => { handlePaid(p).catch((e) => console.error('[flow] paid', e.message)); });
}

module.exports = { groups, getGroup, runFlow, confirm, settle, handleInbound, handlePaid, wire };

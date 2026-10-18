// lib/chat.test.js - plain node, no framework. `node lib/chat.test.js`.
// Always takes the stub path: PHOTON_* is deleted from process.env before requiring
// lib/chat.js (which reads those vars once, at require time, to decide real-vs-stub).

delete process.env.PHOTON_PROJECT_ID;
delete process.env.PHOTON_PROJECT_SECRET;

const assert = require('assert');
const chat = require('./chat');

let failed = false;

function ok(desc) {
  console.log('ok -', desc);
}

function fail(desc, err) {
  failed = true;
  console.error('NOT OK -', desc);
  console.error(err && err.stack ? err.stack : err);
}

function test(desc, fn) {
  try {
    fn();
    ok(desc);
  } catch (err) {
    fail(desc, err);
  }
}

test('status() reports stub with no env vars', () => {
  assert.strictEqual(chat.status(), '[chat] stub');
});

test('send(groupId, text) appends an outbound entry to log(groupId)', () => {
  const before = chat.log('group-a').length;
  chat.send('group-a', 'hello group a');
  const entries = chat.log('group-a');
  assert.strictEqual(entries.length, before + 1);
  const last = entries[entries.length - 1];
  assert.strictEqual(last.dir, 'out');
  assert.strictEqual(last.text, 'hello group a');
  assert.ok(typeof last.ts === 'number');
});

test('log() on a never-seen group returns an empty array, not undefined/throw', () => {
  const entries = chat.log('never-seen-group');
  assert.deepStrictEqual(entries, []);
});

test('onInbound handler fires via simulated flat webhook body, and groupId defaults to demo for an unknown number', () => {
  const received = [];
  chat.onInbound((evt) => received.push(evt));

  const event = chat._handleInboundBody({ from: '+15551234567', text: 'is this thing on' });

  assert.ok(event, 'handleInboundBody should return a parsed event for a valid flat body');
  assert.strictEqual(event.groupId, 'demo');
  assert.strictEqual(event.from, '+15551234567');
  assert.strictEqual(event.text, 'is this thing on');

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].groupId, 'demo');
  assert.strictEqual(received[0].from, '+15551234567');
  assert.strictEqual(received[0].text, 'is this thing on');

  const demoEntries = chat.log('demo');
  const lastIn = demoEntries[demoEntries.length - 1];
  assert.strictEqual(lastIn.dir, 'in');
  assert.strictEqual(lastIn.text, 'is this thing on');
});

test('onInbound handler fires via simulated photon/spectrum-shaped webhook body', () => {
  const received = [];
  chat.onInbound((evt) => received.push(evt));

  const photonBody = {
    type: 'message.received',
    data: {
      object: {
        sentBy: { handle: '+19998887777' },
        content: { text: 'photon-shaped message', type: 'text' },
        space: { id: 'space-xyz' },
      },
    },
  };

  const event = chat._handleInboundBody(photonBody);

  assert.ok(event, 'handleInboundBody should parse the photon/spectrum shape');
  assert.strictEqual(event.groupId, 'space-xyz');
  assert.strictEqual(event.from, '+19998887777');
  assert.strictEqual(event.text, 'photon-shaped message');

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].groupId, 'space-xyz');

  const spaceEntries = chat.log('space-xyz');
  const lastIn = spaceEntries[spaceEntries.length - 1];
  assert.strictEqual(lastIn.dir, 'in');
  assert.strictEqual(lastIn.text, 'photon-shaped message');
});

test('a second inbound message from the same unknown number maps to the same (demo) group', () => {
  const event1 = chat._handleInboundBody({ from: '+12223334444', text: 'first' });
  const event2 = chat._handleInboundBody({ from: '+12223334444', text: 'second' });
  assert.strictEqual(event1.groupId, event2.groupId);
  assert.strictEqual(event1.groupId, 'demo');
});

test('malformed webhook body is handled defensively (no throw, returns null)', () => {
  assert.strictEqual(chat._handleInboundBody({}), null);
  assert.strictEqual(chat._handleInboundBody({ data: {} }), null);
  assert.strictEqual(chat._handleInboundBody(null), null);
});

test('mountWebhook registers a POST /webhook/photon route that responds 200 and invokes handlers', () => {
  let registeredPath = null;
  let registeredHandler = null;
  const fakeApp = {
    post(path, handler) {
      registeredPath = path;
      registeredHandler = handler;
    },
  };

  chat.mountWebhook(fakeApp);
  assert.strictEqual(registeredPath, '/webhook/photon');
  assert.strictEqual(typeof registeredHandler, 'function');

  const received = [];
  chat.onInbound((evt) => received.push(evt));

  let statusSent = null;
  const fakeReq = { body: { from: '+10001112222', text: 'via mounted webhook' } };
  const fakeRes = { sendStatus(code) { statusSent = code; } };

  registeredHandler(fakeReq, fakeRes);

  assert.strictEqual(statusSent, 200);
  assert.strictEqual(received[received.length - 1].text, 'via mounted webhook');
  assert.strictEqual(received[received.length - 1].groupId, 'demo');
});

if (failed) {
  console.error('FAILED');
  process.exit(1);
} else {
  console.log('ALL OK');
}

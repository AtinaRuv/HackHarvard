// lib/chat.js - adapter. See CONTRACT.md.
//
// Real path (PHOTON_PROJECT_ID && PHOTON_PROJECT_SECRET set): lazily imports the ESM
// photon/sendText.js via dynamic import() from this CommonJS module, wrapped in
// try/catch so any failure (missing spectrum-ts dep, network, bad creds, ...) degrades
// to the stub path instead of crashing the server. Inbound messages always arrive via
// the webhook (mountWebhook), never via photon/receiveText.js (that file has an
// infinite loop and imports from ../main.js, which is a different lane's concern).
//
// Stub path: everything lives in an in-memory `logs` map, keyed by groupId.

const REAL = Boolean(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET);

console.log(REAL ? '[chat] real (photon)' : '[chat] stub');

// groupId -> [{dir:'in'|'out', from, text, ts}]
const logs = new Map();

// phone number -> groupId
const numberToGroup = new Map();

// handlers registered via onInbound, called with {from, groupId, text}
const inboundHandlers = [];

function appendLog(groupId, entry) {
  if (!logs.has(groupId)) logs.set(groupId, []);
  logs.get(groupId).push(entry);
}

function groupForNumber(phone) {
  if (!phone) return 'demo';
  if (!numberToGroup.has(phone)) {
    // TODO(service): real group assignment (e.g. by trip/booking). For now every
    // unknown number lands in the single demo group.
    numberToGroup.set(phone, 'demo');
  }
  return numberToGroup.get(phone);
}

// TODO(service): real path has no number->groupId we can send outbound *to* yet
// (we only learn numbers from inbound messages). Track the last-seen number per
// group so send(groupId, text) has somewhere real to deliver to.
const groupToNumber = new Map();

async function sendReal(phone, text) {
  // Lazily import the ESM photon module from this CommonJS file. If spectrum-ts
  // isn't installed, creds are bad, or anything else goes wrong, throw so the
  // caller can fall back to the stub behavior - but never let it escape send().
  const { sendText } = await import('../photon/sendText.js');
  await sendText(phone, text);
}

function send(groupId, text) {
  appendLog(groupId, { dir: 'out', from: null, text, ts: Date.now() });

  const phone = groupToNumber.get(groupId);

  if (REAL && phone) {
    sendReal(phone, text).catch((err) => {
      // TODO(service): surface this failure somewhere other than console - real
      // send failures are currently silent beyond this log line.
      console.error('[chat] real send failed, message was logged only:', err.message);
    });
  } else if (REAL && !phone) {
    console.error('[chat] real send skipped: no known phone number for group', groupId);
  }
  // Stub path (or real-without-known-number): message is already in the log,
  // which is all the demo page needs.
}

function sendToNumber(phone, text) {
  const groupId = groupForNumber(phone);
  groupToNumber.set(groupId, phone);
  appendLog(groupId, { dir: 'out', from: null, text, ts: Date.now() });

  if (REAL) {
    sendReal(phone, text).catch((err) => {
      console.error('[chat] real send failed, message was logged only:', err.message);
    });
  }
}

function onInbound(handler) {
  inboundHandlers.push(handler);
}

// Parses the inbound webhook body defensively. Accepts both the photon/spectrum
// shape (req.body.data.object with sentBy.handle, content.text, space.id) and a
// flat {from, text, groupId} shape (used by tests and simpler integrations).
function parseInboundBody(body) {
  if (!body) return null;

  // Flat shape.
  if (typeof body.text === 'string' && (body.from || body.groupId)) {
    return {
      from: body.from || null,
      text: body.text,
      groupId: body.groupId || null,
    };
  }

  // Photon/spectrum webhook shape: { type, data: { object: {...} } }
  const obj = body.data && body.data.object;
  if (obj) {
    const from = obj.sentBy && obj.sentBy.handle ? obj.sentBy.handle : null;
    const text = obj.content && typeof obj.content.text === 'string' ? obj.content.text : null;
    const groupId = obj.space && obj.space.id ? obj.space.id : null;
    if (text !== null) {
      return { from, text, groupId };
    }
  }

  return null;
}

// Exported separately from mountWebhook so tests can POST a body through this
// function directly without spinning up an express app/http server.
function handleInboundBody(body) {
  const parsed = parseInboundBody(body);
  if (!parsed) return null;

  const groupId = parsed.groupId || groupForNumber(parsed.from);
  if (parsed.from) {
    numberToGroup.set(parsed.from, groupId);
    groupToNumber.set(groupId, parsed.from);
  }

  const event = { from: parsed.from, groupId, text: parsed.text };

  appendLog(groupId, { dir: 'in', from: parsed.from, text: parsed.text, ts: Date.now() });

  for (const handler of inboundHandlers) {
    try {
      handler(event);
    } catch (err) {
      console.error('[chat] onInbound handler threw:', err.message);
    }
  }

  return event;
}

function mountWebhook(app) {
  app.post('/webhook/photon', (req, res) => {
    res.sendStatus(200);
    try {
      handleInboundBody(req.body);
    } catch (err) {
      console.error('[chat] failed to handle inbound webhook body:', err.message);
    }
  });
}

function log(groupId) {
  return logs.get(groupId) || [];
}

function status() {
  return REAL ? '[chat] real (photon)' : '[chat] stub';
}

module.exports = {
  send,
  sendToNumber,
  onInbound,
  mountWebhook,
  log,
  status,
  // exposed for lib/chat.test.js only - not part of the CONTRACT interface.
  _handleInboundBody: handleInboundBody,
};

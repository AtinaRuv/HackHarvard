// lib/demo.js - judge-facing demo page + SSE event bus. See CONTRACT.md.
//
// Not one of the five service adapters - this is the orchestrator's visualization
// lane. No real/stub split; it's just a small pub/sub + static page server.
//
// mount(app)            -> registers GET /demo and GET /events/:groupId (SSE)
// publish(groupId, evt) -> pushes evt to all SSE clients currently watching groupId
//
// Buffers the last BUFFER_SIZE events per group so a judge opening /demo mid-run
// (or reconnecting) replays history instead of seeing a blank page. Sends a ": hb\n\n"
// heartbeat comment every 15s so proxies/load balancers don't kill idle connections.

const path = require('path');

console.log('[demo] ready');

const BUFFER_SIZE = 200;
const HEARTBEAT_MS = 15000;

// groupId -> [event, event, ...] (most recent last, capped at BUFFER_SIZE)
const buffers = new Map();

// groupId -> Set<res>  (open SSE client responses currently watching that group)
const clients = new Map();

function bufferFor(groupId) {
  if (!buffers.has(groupId)) buffers.set(groupId, []);
  return buffers.get(groupId);
}

function clientsFor(groupId) {
  if (!clients.has(groupId)) clients.set(groupId, new Set());
  return clients.get(groupId);
}

function writeEvent(res, event) {
  try {
    res.write('data: ' + JSON.stringify(event) + '\n\n');
  } catch (err) {
    // Client likely disconnected mid-write; the 'close' handler will clean it up.
  }
}

// Called by the orchestrator to push an event to every SSE client watching groupId.
// Event shape: {type, ...payload}. Unknown/extra fields are passed through as-is;
// the browser page is responsible for tolerating unknown types/missing fields.
function publish(groupId, event) {
  if (!groupId || !event || typeof event !== 'object') return;

  const buf = bufferFor(groupId);
  buf.push(event);
  if (buf.length > BUFFER_SIZE) buf.shift();

  for (const res of clientsFor(groupId)) {
    writeEvent(res, event);
  }
}

function mount(app) {
  app.get('/demo', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'demo.html'));
  });

  app.get('/events/:groupId', (req, res) => {
    const groupId = req.params.groupId;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Replay buffered history so a judge connecting mid-run sees everything so far.
    for (const event of bufferFor(groupId)) {
      writeEvent(res, event);
    }

    const set = clientsFor(groupId);
    set.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch (err) {
        // ignore; close handler below will clean up.
      }
    }, HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      set.delete(res);
    });
  });
}

module.exports = {
  mount,
  publish,
};

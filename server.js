// Placeholder - rewritten in Phase 2 by the orchestrator.
// Teammate routes preserved: stripe /payments, /payments/webhook, photon startPhoton.
const express = require('express');
const app = express();
app.use(express.json());
app.get('/ping', (req, res) => res.send('pong'));
app.listen(6767, () => console.log('Server running on port 6767'));

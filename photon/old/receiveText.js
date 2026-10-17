import 'dotenv/config';
import { Photon } from '@photon-ai/api';
import express from 'express';

const photon = new Photon({
    headers: { Authorization: `Bearer ${process.env.PHOTON_API_KEY}` },
});
const PROJECT_ID = process.env.PHOTON_PROJECT_ID;

// 1. Start express server
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
    console.log('event:', JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
});

app.listen(3000, () => console.log('listening on 3000'));

// 2. Register webhook (run once, then comment out)
const dest = await photon.projects.createWebhookDestination({
    path: { id: PROJECT_ID },
    body: {
        url: 'https://YOUR_NGROK_URL/webhook',
        eventTypes: ['message.received'],  // check actual event type names below
    },
});

console.log('webhook registered:', dest);


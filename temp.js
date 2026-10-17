import 'dotenv/config';
import express from 'express';
import { Photon } from '@photon-ai/api';

const app = express();
app.use(express.json());

const photon = new Photon({
    headers: { Authorization: `Bearer ${process.env.PHOTON_API_KEY}` },
});
const PROJECT_ID = process.env.PHOTON_PROJECT_ID;

app.post('/photonWebhook', async (req, res) => {
    res.sendStatus(200);
    const { type, data } = req.body;
    console.log('event:', type);
    if (type === 'message.received') {
        const msg = data.object;
        const senderPhone = msg.sentBy.handle;
        const text = msg.content.text;
        const spaceId = msg.space.id;
        console.log(`[${senderPhone}]: ${text}`);
    }
});

app.listen(3000, () => console.log('server running on 3000'));

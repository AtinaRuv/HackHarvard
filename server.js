const express = require('express');
const paymentRoutes = require('./stripe/routes');
const { stripeWebhook } = require('./stripe/webhook');
const app = express();
// Stripe signature verification needs the untouched bytes, before JSON parsing.
app.post('/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);
app.use(express.json());


app.get("/", (req, res) => res.send("yo"));
app.get("/ping", (req, res) => res.send("pong"));


// ——— PHOTON —————————————————————————————————————————————————————————————————————————————————————————————————————————

app.post('/ping', (req, res) => res.send("pong"));


// ——— NESSIE —————————————————————————————————————————————————————————————————————————————————————————————————————————

// 


// ——— DAYTONA —————————————————————————————————————————————————————————————————————————————————————————————————————————

// 


// ——— STRIPE —————————————————————————————————————————————————————————————————————————————————————————————————————————

app.use('/payments', paymentRoutes);

// ——— FRAUD —————————————————————————————————————————————————————————————————————————————————————————————————————————

// 


// ————————————————————————————————————————————————————————————————————————————————————————————————————————————————— //
app.listen(6767, () => {
    console.log(`Server running on port 6767`);
});


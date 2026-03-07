const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Pendo server running 🚀', users: waitingQueue.length });
});

const MPESA = {
  CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY || 'YOUR_CONSUMER_KEY',
  CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET || 'YOUR_CONSUMER_SECRET',
  SHORTCODE: process.env.MPESA_SHORTCODE || '174379',
  PASSKEY: process.env.MPESA_PASSKEY || 'YOUR_PASSKEY',
  CALLBACK_URL: process.env.MPESA_CALLBACK_URL || 'https://your-backend.railway.app/mpesa/callback',
  ENV: process.env.MPESA_ENV || 'sandbox',
};

const MPESA_BASE = MPESA.ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

async function getMpesaToken() {
  const credentials = Buffer.from(`${MPESA.CONSUMER_KEY}:${MPESA.CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  return res.data.access_token;
}

app.post('/mpesa/stkpush', async (req, res) => {
  const { phone, amount, accountRef } = req.body;
  const normalizedPhone = phone.startsWith('0') ? '254' + phone.slice(1) : phone.replace('+', '');
  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const password = Buffer.from(`${MPESA.SHORTCODE}${MPESA.PASSKEY}${timestamp}`).toString('base64');
  try {
    const token = await getMpesaToken();
    const response = await axios.post(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: MPESA.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: normalizedPhone,
      PartyB: MPESA.SHORTCODE,
      PhoneNumber: normalizedPhone,
      CallBackURL: MPESA.CALLBACK_URL,
      AccountReference: accountRef || 'PendoPremium',
      TransactionDesc: 'Pendo Premium Subscription',
    }, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.response?.data || err.message });
  }
});

app.post('/mpesa/callback', (req, res) => {
  const result = req.body?.Body?.stkCallback;
  if (result?.ResultCode === 0) {
    const meta = result.CallbackMetadata?.Item || [];
    const amount = meta.find(i => i.Name === 'Amount')?.Value;
    const phone = meta.find(i => i.Name === 'PhoneNumber')?.Value;
    console.log(`✅ Payment: KES ${amount} from ${phone}`);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

let waitingQueue = [];
const activePairs = new Map();

io.on('connection', (socket) => {
  console.log(`🟢 Connected: ${socket.id}`);

  socket.on('find_match', (userData) => {
    socket.userData = userData || {};
    if (waitingQueue.length > 0) {
      const partner = waitingQueue.shift();
      activePairs.set(socket.id, partner.id);
      activePairs.set(partner.id, socket.id);
      socket.emit('match_found', { partnerId: partner.id, initiator: false, partnerData: partner.userData });
      partner.emit('match_found', { partnerId: socket.id, initiator: true, partnerData: socket.userData });
    } else {
      waitingQueue.push(socket);
      socket.emit('waiting', { message: 'Looking for someone...' });
    }
  });

  socket.on('offer', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('offer', { sdp: data.sdp, from: socket.id });
  });

  socket.on('answer', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('answer', { sdp: data.sdp, from: socket.id });
  });

  socket.on('ice_candidate', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('ice_candidate', { candidate: data.candidate, from: socket.id });
  });

  socket.on('send_like', () => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('received_like', { from: socket.id, fromData: socket.userData });
  });

  socket.on('video_message', (msg) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('video_message', { text: msg, from: socket.id });
  });

  socket.on('disconnect', () => {
    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    const partnerId = activePairs.get(socket.id);
    if (partnerId) { io.to(partnerId).emit('partner_disconnected'); activePairs.delete(partnerId); }
    activePairs.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Pendo running on port ${PORT}`));

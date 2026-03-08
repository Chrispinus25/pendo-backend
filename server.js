const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Pendo 🚀', online: io.engine.clientsCount });
});

// M-Pesa
const MPESA = {
  CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY || '',
  CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET || '',
  SHORTCODE: process.env.MPESA_SHORTCODE || '174379',
  PASSKEY: process.env.MPESA_PASSKEY || '',
  CALLBACK_URL: process.env.MPESA_CALLBACK_URL || '',
  ENV: process.env.MPESA_ENV || 'sandbox',
};
const MPESA_BASE = MPESA.ENV==='production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
async function getMpesaToken(){ const c=Buffer.from(`${MPESA.CONSUMER_KEY}:${MPESA.CONSUMER_SECRET}`).toString('base64'); const r=await axios.get(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${c}`}}); return r.data.access_token; }
app.post('/mpesa/stkpush', async(req,res)=>{ const {phone,amount,accountRef}=req.body; const p=phone.startsWith('0')?'254'+phone.slice(1):phone.replace('+',''); const ts=new Date().toISOString().replace(/[-T:.Z]/g,'').slice(0,14); const pw=Buffer.from(`${MPESA.SHORTCODE}${MPESA.PASSKEY}${ts}`).toString('base64'); try{ const t=await getMpesaToken(); const r=await axios.post(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,{BusinessShortCode:MPESA.SHORTCODE,Password:pw,Timestamp:ts,TransactionType:'CustomerPayBillOnline',Amount:amount,PartyA:p,PartyB:MPESA.SHORTCODE,PhoneNumber:p,CallBackURL:MPESA.CALLBACK_URL,AccountReference:accountRef||'Pendo',TransactionDesc:'Pendo Premium'},{headers:{Authorization:`Bearer ${t}`}}); res.json({success:true,data:r.data}); }catch(e){ res.status(500).json({success:false,error:e?.response?.data||e.message}); } });
app.post('/mpesa/callback',(req,res)=>{ const r=req.body?.Body?.stkCallback; if(r?.ResultCode===0){ const m=r.CallbackMetadata?.Item||[]; console.log(`✅ KES ${m.find(i=>i.Name==='Amount')?.Value} from ${m.find(i=>i.Name==='PhoneNumber')?.Value}`); } res.json({ResultCode:0,ResultDesc:'Accepted'}); });

// Matching
let waitingQueue = [];
const activePairs = new Map();

function broadcastCount(){
  const count = io.engine.clientsCount;
  io.emit('online_count', count);
}

io.on('connection', (socket) => {
  console.log(`🟢 ${socket.id} connected. Total: ${io.engine.clientsCount}`);
  broadcastCount();

  socket.on('find_match', (userData) => {
    socket.userData = userData || {};
    // Remove from queue if already there
    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    // Disconnect existing pair
    const oldPartner = activePairs.get(socket.id);
    if(oldPartner){ io.to(oldPartner).emit('partner_disconnected'); activePairs.delete(oldPartner); activePairs.delete(socket.id); }

    if(waitingQueue.length > 0){
      const partner = waitingQueue.shift();
      activePairs.set(socket.id, partner.id);
      activePairs.set(partner.id, socket.id);
      socket.emit('match_found', { partnerId: partner.id, initiator: false, partnerData: partner.userData });
      partner.emit('match_found', { partnerId: socket.id, initiator: true, partnerData: socket.userData });
      console.log(`💑 Matched: ${socket.id} ↔ ${partner.id}`);
    } else {
      waitingQueue.push(socket);
      socket.emit('waiting', { message: 'Looking for someone...' });
    }
  });

  socket.on('offer', data => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('offer',{sdp:data.sdp,from:socket.id}); });
  socket.on('answer', data => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('answer',{sdp:data.sdp,from:socket.id}); });
  socket.on('ice_candidate', data => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('ice_candidate',{candidate:data.candidate}); });
  socket.on('video_message', msg => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('video_message',{text:msg,from:socket.id}); });
  socket.on('send_like', () => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('received_like',{fromData:socket.userData}); });

  socket.on('disconnect', () => {
    console.log(`🔴 ${socket.id} disconnected`);
    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    const partnerId = activePairs.get(socket.id);
    if(partnerId){ io.to(partnerId).emit('partner_disconnected'); activePairs.delete(partnerId); }
    activePairs.delete(socket.id);
    setTimeout(broadcastCount, 500);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Pendo on port ${PORT}`));

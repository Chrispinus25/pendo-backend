const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors:{origin:'*',methods:['GET','POST']},
  pingTimeout:60000, pingInterval:25000,
});
app.use(cors());
app.use(express.json());

// Metered TURN credentials
const METERED_DOMAIN = process.env.METERED_DOMAIN || 'pendochating.metered.live';
const METERED_KEY    = process.env.METERED_KEY    || 'KSf_3n_VKRulFc1r61Udltc9CnryRDy8oviOkUAWFSkInwD0';

let cachedIceServers = null;
let iceServersFetchedAt = 0;

async function getIceServers() {
  const now = Date.now();
  // Cache for 1 hour
  if (cachedIceServers && (now - iceServersFetchedAt) < 3600000) return cachedIceServers;
  try {
    const url = `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_KEY}`;
    const res = await axios.get(url);
    cachedIceServers = res.data;
    iceServersFetchedAt = now;
    console.log('✅ TURN credentials fetched:', cachedIceServers.length, 'servers');
    return cachedIceServers;
  } catch(e) {
    console.error('❌ Failed to fetch TURN credentials:', e.message);
    // Fallback to Google STUN only
    return [{urls:'stun:stun.l.google.com:19302'}];
  }
}

app.get('/', (req,res) => res.json({status:'Pendo 🚀', online: io.engine.clientsCount}));

// Endpoint for frontend to get ICE servers
app.get('/ice-servers', async(req,res) => {
  const servers = await getIceServers();
  res.json(servers);
});

// M-Pesa
const MPESA={CONSUMER_KEY:process.env.MPESA_CONSUMER_KEY||'',CONSUMER_SECRET:process.env.MPESA_CONSUMER_SECRET||'',SHORTCODE:process.env.MPESA_SHORTCODE||'174379',PASSKEY:process.env.MPESA_PASSKEY||'',CALLBACK_URL:process.env.MPESA_CALLBACK_URL||'',ENV:process.env.MPESA_ENV||'sandbox'};
const MPESA_BASE=MPESA.ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
async function getMpesaToken(){const c=Buffer.from(`${MPESA.CONSUMER_KEY}:${MPESA.CONSUMER_SECRET}`).toString('base64');const r=await axios.get(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${c}`}});return r.data.access_token;}
app.post('/mpesa/stkpush',async(req,res)=>{const{phone,amount,accountRef}=req.body;const p=phone.startsWith('0')?'254'+phone.slice(1):phone.replace('+','');const ts=new Date().toISOString().replace(/[-T:.Z]/g,'').slice(0,14);const pw=Buffer.from(`${MPESA.SHORTCODE}${MPESA.PASSKEY}${ts}`).toString('base64');try{const t=await getMpesaToken();const r=await axios.post(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,{BusinessShortCode:MPESA.SHORTCODE,Password:pw,Timestamp:ts,TransactionType:'CustomerPayBillOnline',Amount:amount,PartyA:p,PartyB:MPESA.SHORTCODE,PhoneNumber:p,CallBackURL:MPESA.CALLBACK_URL,AccountReference:accountRef||'Pendo',TransactionDesc:'Pendo Premium'},{headers:{Authorization:`Bearer ${t}`}});res.json({success:true,data:r.data});}catch(e){res.status(500).json({success:false,error:e?.response?.data||e.message});}});
app.post('/mpesa/callback',(req,res)=>{const r=req.body?.Body?.stkCallback;if(r?.ResultCode===0){const m=r.CallbackMetadata?.Item||[];console.log(`✅ KES ${m.find(i=>i.Name==='Amount')?.Value}`);}res.json({ResultCode:0,ResultDesc:'Accepted'});});

// Users & matching
const users = {};
let waitingQueue = [];
const activePairs = new Map();

function broadcastAll(){
  io.emit('online_count', io.engine.clientsCount);
  io.emit('users_list', users);
}

io.on('connection', socket => {
  console.log(`🟢 ${socket.id} | total: ${io.engine.clientsCount}`);

  socket.on('find_match', async userData => {
    const name = userData?.name || 'Anonymous';
    socket.userData = {name};
    users[socket.id] = {name};
    broadcastAll();

    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    const oldPartner = activePairs.get(socket.id);
    if(oldPartner){ io.to(oldPartner).emit('partner_disconnected'); activePairs.delete(oldPartner); activePairs.delete(socket.id); }

    // Fetch fresh ICE servers for each match
    const iceServers = await getIceServers();

    if(waitingQueue.length > 0){
      const partner = waitingQueue.shift();
      activePairs.set(socket.id, partner.id);
      activePairs.set(partner.id, socket.id);
      socket.emit('match_found',  {partnerId:partner.id, initiator:false, partnerData:partner.userData, iceServers});
      partner.emit('match_found', {partnerId:socket.id,  initiator:true,  partnerData:socket.userData,  iceServers});
      console.log(`💑 ${name} ↔ ${partner.userData?.name}`);
    } else {
      waitingQueue.push(socket);
      socket.emit('waiting', {});
    }
  });

  socket.on('offer',         d => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('offer',        {sdp:d.sdp}); });
  socket.on('answer',        d => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('answer',       {sdp:d.sdp}); });
  socket.on('ice_candidate', d => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('ice_candidate',{candidate:d.candidate}); });
  socket.on('video_message', d => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('video_message',{text:d.text||d, name:socket.userData?.name}); });

  socket.on('disconnect', () => {
    console.log(`🔴 ${socket.id}`);
    delete users[socket.id];
    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    const partnerId = activePairs.get(socket.id);
    if(partnerId){ io.to(partnerId).emit('partner_disconnected'); activePairs.delete(partnerId); }
    activePairs.delete(socket.id);
    setTimeout(broadcastAll, 300);
  });
});

// Pre-fetch TURN on startup
getIceServers();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Pendo on port ${PORT}`));

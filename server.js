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
const METERED_KEY    = process.env.METERED_KEY    || 'KSf_3n_VKRu1Fc1r61Ud1tc9CnryRDy8oviOkUAWF5kInwD0';

let cachedIceServers = null;
let iceServersFetchedAt = 0;

async function getIceServers() {
  const now = Date.now();
  if (cachedIceServers && now - iceServersFetchedAt < 3600000) return cachedIceServers;
  try {
    const r = await axios.get(`https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_KEY}`);
    cachedIceServers = r.data;
    iceServersFetchedAt = now;
    return cachedIceServers;
  } catch(e) {
    return [{ urls:'stun:stun.l.google.com:19302' }];
  }
}

app.get('/', (req, res) => res.send('ChatZap server is running ✅'));
app.get('/online', (req, res) => res.json({ count: onlineCount }));

// ── ChatZap matchmaking state ──
let waitingQueue = [];
let activePairs  = {};
let onlineCount  = 0;

function isCompatible(a, b) {
  const countryOk = !a.filters.country || !b.filters.country || a.filters.country === b.filters.country;
  const genderOk  = !a.filters.pref || a.filters.pref === 'any' || a.filters.pref === b.filters.gender;
  const reverseOk = !b.filters.pref || b.filters.pref === 'any' || b.filters.pref === a.filters.gender;
  return countryOk && genderOk && reverseOk;
}

function findMatch(user) {
  for (let i = 0; i < waitingQueue.length; i++) {
    if (waitingQueue[i].id !== user.id && isCompatible(waitingQueue[i], user)) return i;
  }
  return -1;
}

function removeFromQueue(id) {
  waitingQueue = waitingQueue.filter(u => u.id !== id);
}

io.on('connection', (socket) => {
  onlineCount++;
  io.emit('online_count', onlineCount);
  console.log(`[+] ${socket.id} | Online: ${onlineCount}`);

  // Send ICE servers on connect
  getIceServers().then(ice => socket.emit('ice_servers', ice));

  socket.on('find_match', (filters = {}) => {
    if (activePairs[socket.id]) {
      const p = activePairs[socket.id];
      delete activePairs[p];
      delete activePairs[socket.id];
      io.to(p).emit('partner_left');
    }
    removeFromQueue(socket.id);

    const user = { id: socket.id, filters: { country: filters.country||'', gender: filters.gender||'', pref: filters.pref||'any' }};
    const idx = findMatch(user);

    if (idx !== -1) {
      const partner = waitingQueue[idx];
      waitingQueue.splice(idx, 1);
      activePairs[socket.id] = partner.id;
      activePairs[partner.id] = socket.id;
      socket.emit('matched', { partnerId: partner.id, role: 'caller' });
      io.to(partner.id).emit('matched', { partnerId: socket.id, role: 'callee' });
      console.log(`[✓] Matched: ${socket.id} ↔ ${partner.id}`);
    } else {
      waitingQueue.push(user);
      socket.emit('waiting');
      console.log(`[~] Waiting: ${socket.id} | Queue: ${waitingQueue.length}`);
    }
  });

  socket.on('offer',         d => io.to(d.to).emit('offer',         { from: socket.id, sdp: d.sdp }));
  socket.on('answer',        d => io.to(d.to).emit('answer',        { from: socket.id, sdp: d.sdp }));
  socket.on('ice_candidate', d => io.to(d.to).emit('ice_candidate', { from: socket.id, candidate: d.candidate }));

  socket.on('skip', () => {
    const p = activePairs[socket.id];
    if (p) { io.to(p).emit('partner_left'); delete activePairs[p]; delete activePairs[socket.id]; }
    removeFromQueue(socket.id);
    socket.emit('skipped');
  });

  socket.on('chat_message', msg => {
    const p = activePairs[socket.id];
    if (p) io.to(p).emit('chat_message', { text: msg.text, from: 'stranger' });
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit('online_count', onlineCount);
    const p = activePairs[socket.id];
    if (p) { io.to(p).emit('partner_left'); delete activePairs[p]; }
    delete activePairs[socket.id];
    removeFromQueue(socket.id);
    console.log(`[-] ${socket.id} | Online: ${onlineCount}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 ChatZap running on port ${PORT}`));

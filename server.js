// server.js
import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 8080;

/* ---------- tiny HTTP server for health ---------- */
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hides-signal running');
});
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => console.log(`[signaling] listening on :${PORT}`));

/* ---------- state ---------- */
const queue = [];                    // waiting clients
const peers = new Map();             // id -> ws
const partnerOf = new Map();         // id -> partner id
// ws._state in {'idle','queued','paired'}

/* ---------- helpers ---------- */
const send = (ws, type, payload = {}) => {
  try { ws.send(JSON.stringify({ type, ...payload })); } catch {}
};
const removeFromQueue = (ws) => {
  const i = queue.indexOf(ws);
  if (i >= 0) queue.splice(i, 1);
};

function pair(a, b) {
  if (!a || !b || a === b) return;
  // do not pair if someone is already paired
  if (a._state === 'paired' || b._state === 'paired') return;

  removeFromQueue(a);
  removeFromQueue(b);

  const aid = a._id, bid = b._id;
  partnerOf.set(aid, bid);
  partnerOf.set(bid, aid);
  a._state = 'paired';
  b._state = 'paired';

  send(a, 'paired', { role: 'caller', partnerId: bid });
  send(b, 'paired', { role: 'callee', partnerId: aid });
  console.log(`[pair] ${aid} <-> ${bid}`);
}

function enqueue(ws) {
  // if already paired, ignore (or force next via 'next')
  if (ws._state === 'paired') return;

  removeFromQueue(ws);
  if (queue.length) {
    const other = queue.shift();
    if (other && other.readyState === 1 && other._state !== 'paired') {
      pair(ws, other);
    } else {
      // other was closed/paired; try again
      enqueue(ws);
    }
  } else {
    ws._state = 'queued';
    queue.push(ws);
    send(ws, 'queued', {});
  }
}

function unpair(id, notify = true) {
  const p = partnerOf.get(id);
  partnerOf.delete(id);
  const ws = peers.get(id);
  if (ws) ws._state = 'idle';

  if (p) {
    partnerOf.delete(p);
    const pw = peers.get(p);
    if (pw) pw._state = 'idle';
    if (notify && pw) send(pw, 'unpaired', {});
  }
  if (notify && ws) send(ws, 'unpaired', {});
}

/* ---------- ws events ---------- */
wss.on('connection', (ws) => {
  ws._id = uuidv4();
  ws._state = 'idle';
  peers.set(ws._id, ws);
  send(ws, 'hello', { id: ws._id });

  // auto-queue on connect
  enqueue(ws);

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const pid = partnerOf.get(ws._id);
    const partner = pid ? peers.get(pid) : null;

    switch (msg.type) {
      case 'find':
        // if paired, move both back to queue cleanly
        if (ws._state === 'paired') {
          unpair(ws._id, false);
        }
        enqueue(ws);
        break;

      case 'cancel':
        removeFromQueue(ws);
        ws._state = 'idle';
        break;

      case 'signal':
        if (partner && partner.readyState === 1 && ws._state === 'paired') {
          send(partner, 'signal', { data: msg.data });
        }
        break;

      case 'next': {
        // leave current partner (if any) and re-queue both
        const oldPartner = partner;
        unpair(ws._id, false);
        enqueue(ws);
        if (oldPartner && oldPartner.readyState === 1) enqueue(oldPartner);
        break;
      }

      case 'bye':
        unpair(ws._id, true);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    removeFromQueue(ws);
    unpair(ws._id, true);
    peers.delete(ws._id);
    partnerOf.delete(ws._id);
  });
});

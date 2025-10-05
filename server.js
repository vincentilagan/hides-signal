import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
console.log(`[signaling] listening on :${PORT}`);

const queue = []; // waiting clients
const peers = new Map(); // id -> ws
const partnerOf = new Map(); // id -> partner id

function send(ws, type, payload={}){
  try{ ws.send(JSON.stringify({ type, ...payload })); }catch{}
}

function pair(a, b){
  if (!a || !b || a === b) return;
  const aid = a._id, bid = b._id;
  partnerOf.set(aid, bid);
  partnerOf.set(bid, aid);
  send(a, 'paired', { role: 'caller', partnerId: bid });
  send(b, 'paired', { role: 'callee', partnerId: aid });
}

function enqueue(ws){
  const i = queue.indexOf(ws);
  if (i>=0) queue.splice(i,1);
  if (queue.length){
    const other = queue.shift();
    if (other.readyState === 1) pair(ws, other);
    else enqueue(ws);
  } else {
    queue.push(ws);
    send(ws, 'queued', {});
  }
}

function unpair(id, notify=true){
  const p = partnerOf.get(id);
  partnerOf.delete(id);
  if (p) partnerOf.delete(p);
  const ws = peers.get(id);
  const pw = peers.get(p);
  if (notify){
    if (ws) send(ws, 'unpaired', {});
    if (pw) send(pw, 'unpaired', {});
  }
}

wss.on('connection', (ws) => {
  ws._id = uuidv4();
  peers.set(ws._id, ws);
  send(ws, 'hello', { id: ws._id });
  enqueue(ws); // auto-find

  ws.on('message', (raw)=>{
    let msg; try{ msg = JSON.parse(raw); }catch{ return; }
    const pid = partnerOf.get(ws._id);
    const partner = pid ? peers.get(pid) : null;
    switch(msg.type){
      case 'find': enqueue(ws); break;
      case 'cancel': { const i = queue.indexOf(ws); if (i>=0) queue.splice(i,1); } break;
      case 'signal':
        if (partner && partner.readyState === 1){
          send(partner, 'signal', { data: msg.data });
        }
        break;
      case 'next':
        unpair(ws._id, false);
        enqueue(ws);
        if (partner && partner.readyState === 1) enqueue(partner);
        break;
      case 'bye':
        unpair(ws._id, true);
        break;
      default: break;
    }
  });

  ws.on('close', ()=>{
    const i = queue.indexOf(ws); if (i>=0) queue.splice(i,1);
    unpair(ws._id, true);
    peers.delete(ws._id);
    partnerOf.delete(ws._id);
  });
});

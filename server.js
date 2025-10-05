// server.js  — hides-signal (rooms MVP: host + 3 seats)
import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 8080;

/* ---------- tiny HTTP for health ---------- */
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hides-signal running');
});
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => console.log(`[signaling] listening on :${PORT}`));

/* ---------- state ---------- */
const peers = new Map(); // id -> ws
const rooms = new Map(); // roomId -> { id,title,hostId,seats:[id|null,id|null,id|null,id|null], members:Set<id> }

function send(ws, type, payload = {}) { try { ws.send(JSON.stringify({ type, ...payload })); } catch {} }
function broadcastRoom(roomId, type, payload = {}) {
  const room = rooms.get(roomId); if (!room) return;
  for (const id of room.members) { const ws = peers.get(id); if (ws?.readyState === 1) send(ws, type, payload); }
}
function roomState(room) {
  return { room: { id: room.id, title: room.title, hostId: room.hostId, seats: room.seats, audience: room.members.size } };
}
function listRoomsPayload() {
  return { rooms: [...rooms.values()].map(r => ({ id: r.id, title: r.title, hostId: r.hostId, seats: r.seats })) };
}
function ensureMember(ws, roomId) {
  const room = rooms.get(roomId); if (!room) return null;
  room.members.add(ws._id);
  ws._roomId = roomId;
  return room;
}
function leaveRoom(ws) {
  const roomId = ws._roomId; if (!roomId) return;
  const room = rooms.get(roomId); if (!room) { ws._roomId=null; return; }

  // free seat if seated
  const idx = room.seats.indexOf(ws._id);
  if (idx >= 0) room.seats[idx] = null;

  // if host leaves -> promote first seated to host
  if (room.hostId === ws._id) {
    const nextHost = room.seats.find(id => !!id);
    room.hostId = nextHost || null;
  }
  room.members.delete(ws._id);
  ws._roomId = null; ws._role = 'audience'; ws._seat = null;

  // clean empty room
  const stillMembers = room.members.size;
  const hasAnySeat = room.seats.some(Boolean);
  if (!stillMembers || (!hasAnySeat && !room.hostId)) {
    rooms.delete(room.id);
  } else {
    broadcastRoom(roomId, 'room_state', roomState(room));
  }
}

wss.on('connection', (ws) => {
  ws._id = uuidv4();
  ws._role = 'audience'; // 'host' | 'guest' | 'audience'
  ws._seat = null;       // 0..3 or null
  ws._roomId = null;
  peers.set(ws._id, ws);
  send(ws, 'hello', { id: ws._id });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const type = m.type;

    switch (type) {

      /* ---- lobby ---- */
      case 'list_rooms': {
        send(ws, 'rooms', listRoomsPayload());
        break;
      }
      case 'create_room': {
        const title = (m.title || 'Room').toString().slice(0, 60);
        const id = uuidv4().slice(0, 8);
        const room = { id, title, hostId: ws._id, seats: [ws._id, null, null, null], members: new Set([ws._id]) };
        rooms.set(id, room);
        ws._roomId = id; ws._role = 'host'; ws._seat = 0;
        send(ws, 'room_created', { id, title });
        send(ws, 'room_state', roomState(room));
        broadcastRoom(id, 'rooms', listRoomsPayload()); // update lobby lists
        break;
      }
      case 'join_room': {
        const room = rooms.get(m.roomId);
        if (!room) { send(ws, 'error', { message: 'room_not_found' }); break; }
        ensureMember(ws, room.id);
        ws._role = 'audience'; ws._seat = null;
        send(ws, 'joined', { roomId: room.id });
        send(ws, 'room_state', roomState(room));
        break;
      }
      case 'leave_room': {
        leaveRoom(ws);
        send(ws, 'left', {});
        broadcastRoom(m.roomId, 'rooms', listRoomsPayload());
        break;
      }

      /* ---- seats (auto-approve MVP) ---- */
      case 'request_seat': {
        const room = rooms.get(ws._roomId); if (!room) break;
        if (ws._seat !== null) break; // already seated
        const free = room.seats.findIndex(x => x === null);
        if (free === -1) { send(ws, 'seat_denied', { reason: 'full' }); break; }
        room.seats[free] = ws._id; ws._seat = free; ws._role = (room.hostId === ws._id) ? 'host' : 'guest';
        broadcastRoom(room.id, 'room_state', roomState(room));
        break;
      }
      case 'leave_seat': {
        const room = rooms.get(ws._roomId); if (!room) break;
        const i = room.seats.indexOf(ws._id);
        if (i >= 0) room.seats[i] = null;
        ws._seat = null; ws._role = 'audience';
        broadcastRoom(room.id, 'room_state', roomState(room));
        break;
      }

      /* ---- signaling (to specific peer inside same room) ---- */
      case 'signal': {
        const to = peers.get(m.to);
        if (!to) break;
        if (ws._roomId && ws._roomId === to._roomId) {
          send(to, 'signal', { from: ws._id, data: m.data });
        }
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    peers.delete(ws._id);
  });
});

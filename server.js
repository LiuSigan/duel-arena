// 双人对战射击 —— 联机服务器
// 职责：托管游戏页面 + WebSocket 中继（房间配对、消息转发）
// 游戏逻辑全部在客户端：房主(host)跑物理模拟，加入方(guest)发送按键输入

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// code -> { host: ws, guest: ws|null }
const rooms = new Map();
// 快速匹配等待队列（最多一人，来第二个就配对）
let waitingPlayer = null;

function makeCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 7).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function otherPeer(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  return ws === room.host ? room.guest : room.host;
}

function startMatch(room) {
  send(room.host, { type: 'start', role: 'host', config: room.config });
  send(room.guest, { type: 'start', role: 'guest', config: room.config });
}

wss.on('connection', (ws) => {
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // ---- 创建私人房间 ----
      case 'create': {
        const code = makeCode();
        rooms.set(code, { host: ws, guest: null, config: msg.config || null });
        ws.roomCode = code;
        send(ws, { type: 'room', code });
        break;
      }

      // ---- 用房间号加入 ----
      case 'join': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'error', reason: '房间不存在，请核对房间号' }); return; }
        if (room.guest) { send(ws, { type: 'error', reason: '房间已满' }); return; }
        room.guest = ws;
        ws.roomCode = code;
        startMatch(room);
        break;
      }

      // ---- 快速匹配 ----
      case 'quickmatch': {
        if (waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === ws.OPEN) {
          const code = makeCode();
          const room = { host: waitingPlayer, guest: ws, config: waitingPlayer.config || null };
          rooms.set(code, room);
          waitingPlayer.roomCode = code;
          ws.roomCode = code;
          waitingPlayer = null;
          startMatch(room);
        } else {
          ws.config = msg.config || null;
          waitingPlayer = ws;
          send(ws, { type: 'waiting' });
        }
        break;
      }

      case 'cancelmatch': {
        if (waitingPlayer === ws) waitingPlayer = null;
        break;
      }

      // ---- 游戏数据：input / state / restart / resetMatch 一律转发给同房间对方 ----
      case 'input':
      case 'state':
      case 'restart':
      case 'resetMatch': {
        const peer = otherPeer(ws);
        if (peer) send(peer, msg);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (waitingPlayer === ws) waitingPlayer = null;
    const room = rooms.get(ws.roomCode);
    if (room) {
      const peer = ws === room.host ? room.guest : room.host;
      send(peer, { type: 'peer-left' });
      rooms.delete(ws.roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`双人对战服务器已启动: http://localhost:${PORT}`);
});

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
const wss = new WebSocketServer({
  server,
  perMessageDeflate: {
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    threshold: 512,
  },
});

// code -> { host: ws, guest: ws|null }
const rooms = new Map();
// 快速匹配等待队列（最多一人，来第二个就配对）
let waitingPlayer = null;
// 游戏状态是实时快照：旧 state 没有补发价值。这里做合并/节流，避免客端网络或设备稍慢时
// WebSocket 可靠队列越积越长，看到的画面变成过期录像。
const STATE_FORWARD_INTERVAL_MS = 1000 / 30;
const POSE_FORWARD_INTERVAL_MS = 1000 / 45;
const MAX_STATE_BUFFERED_BYTES = 128 * 1024;

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

function clearStateQueue(ws) {
  if (!ws) return;
  if (ws.stateFlushTimer) clearTimeout(ws.stateFlushTimer);
  if (ws.poseFlushTimer) clearTimeout(ws.poseFlushTimer);
  ws.stateFlushTimer = null;
  ws.poseFlushTimer = null;
  ws.latestStateMsg = null;
  ws.latestPoseMsg = null;
}

function flushLatestState(ws) {
  ws.stateFlushTimer = null;
  const msg = ws.latestStateMsg;
  ws.latestStateMsg = null;
  if (!msg || !ws || ws.readyState !== ws.OPEN) return;

  // 下游还没消化完时直接丢弃这帧。下一帧 host 会发来更新的快照，实时游戏宁要新包不要旧包。
  if (ws.bufferedAmount > MAX_STATE_BUFFERED_BYTES) return;

  send(ws, msg);
  ws.lastStateSentAt = Date.now();
}

function sendLatestState(ws, msg) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.latestStateMsg = msg;
  if (ws.stateFlushTimer) return;

  const elapsed = Date.now() - (ws.lastStateSentAt || 0);
  const delay = Math.max(0, STATE_FORWARD_INTERVAL_MS - elapsed);
  ws.stateFlushTimer = setTimeout(() => flushLatestState(ws), delay);
}

function flushLatestPose(ws) {
  ws.poseFlushTimer = null;
  const msg = ws.latestPoseMsg;
  ws.latestPoseMsg = null;
  if (!msg || !ws || ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_STATE_BUFFERED_BYTES) return;

  send(ws, msg);
  ws.lastPoseSentAt = Date.now();
}

function sendLatestPose(ws, msg) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.latestPoseMsg = msg;
  if (ws.poseFlushTimer) return;

  const elapsed = Date.now() - (ws.lastPoseSentAt || 0);
  const delay = Math.max(0, POSE_FORWARD_INTERVAL_MS - elapsed);
  ws.poseFlushTimer = setTimeout(() => flushLatestPose(ws), delay);
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

      // ---- 控制/房间指令：保持即时转发 ----
      case 'input':
      case 'shot':
      case 'restart':
      case 'resetMatch': {
        const peer = otherPeer(ws);
        if (peer) send(peer, msg);
        break;
      }

      // ---- 玩家位置：只保留最新姿态，避免旧位置排队造成回放式抖动 ----
      case 'pose': {
        const peer = otherPeer(ws);
        if (peer) sendLatestPose(peer, msg);
        break;
      }

      // ---- 游戏状态：只转发最新快照，旧快照可以丢弃 ----
      case 'state': {
        const peer = otherPeer(ws);
        if (peer) {
          if (msg.critical) {
            clearStateQueue(peer);
            send(peer, msg);
            peer.lastStateSentAt = Date.now();
          } else {
            sendLatestState(peer, msg);
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (waitingPlayer === ws) waitingPlayer = null;
    const room = rooms.get(ws.roomCode);
    if (room) {
      const peer = ws === room.host ? room.guest : room.host;
      clearStateQueue(ws);
      clearStateQueue(peer);
      send(peer, { type: 'peer-left' });
      rooms.delete(ws.roomCode);
    } else {
      clearStateQueue(ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`双人对战服务器已启动: http://localhost:${PORT}`);
});

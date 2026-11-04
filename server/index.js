// v4 服务端入口:express(HTTP + 静态) + ws(y-websocket 协同中继)。
// 结构:db.js(SQLite) / resetV3.js(v3 归档) / auth.js(凭据) / rooms.js(房间簿,过渡)
//       sweeper.js(统一清扫) / routes/{auth,uploads}.js;配对 v2 与文档路由随后接入。
// 注意:v4 全新开始 —— 首次启动会把 v3 数据归档(docs/identity-and-sharing.md §6)。
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { setupWSConnection, setPersistence } from 'y-websocket/bin/utils';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { runResetV3 } from './resetV3.js';
import { authenticate } from './auth.js';
import { startSweeper } from './sweeper.js';
import { makePersistence, checkDocForConnection, flushAllSync } from './docStore.js';
import { authRouter } from './routes/auth.js';
import { pairRouter } from './routes/pair.js';
import { attachmentsRouter } from './routes/attachments.js';
import { docsRouter } from './routes/docs.js';
import { listTrash } from './docStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 归档必须先于任何数据访问(db 惰性打开,这里顺序即保障)
runResetV3();
getDb();
// 文档快照持久化(§4.2):bindState 同步读盘 + 防抖写库 + 断开即卸载
setPersistence(makePersistence());
// 容器 stop:刷写脏文档再退(SIGTERM/SIGINT 都接)
process.on('SIGTERM', () => {
  try {
    flushAllSync();
  } catch (e) {
    console.error('[docs] flush on exit failed:', e.message);
  }
  process.exit(0);
});

const app = express();
app.use(cors());
app.use(express.json());

// D15 扩大面:全部 /auth 响应不可缓存(含一次性恢复密钥/设备列表)
app.use('/auth', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ---------- WS 连接注册表(吊销/注销/文档删除时定向关闭) ----------

/** deviceId → Set<ws> */
const wsByDevice = new Map();
/** docCode → Set<ws> */
const wsByDoc = new Map();

function trackWs(ws, deviceId, code) {
  let set = wsByDevice.get(deviceId);
  if (!set) wsByDevice.set(deviceId, (set = new Set()));
  set.add(ws);
  let docSet = wsByDoc.get(code);
  if (!docSet) wsByDoc.set(code, (docSet = new Set()));
  docSet.add(ws);
  ws.on('close', () => {
    set.delete(ws);
    if (set.size === 0) wsByDevice.delete(deviceId);
    docSet.delete(ws);
    if (docSet.size === 0) wsByDoc.delete(code);
  });
}

function closeDeviceWs(deviceIds, code = 4001, reason = 'device revoked') {
  for (const id of deviceIds) {
    for (const ws of wsByDevice.get(id) ?? []) ws.close(code, reason);
  }
}

function closeDocWs(codes, code = 4004, reason = 'doc unavailable') {
  for (const c of codes) {
    for (const ws of wsByDoc.get(c) ?? []) ws.close(code, reason);
  }
}

// ---------- 路由 ----------

const roomStats = new Map(); // 在线统计(/health 用;L2 收敛为只回数量)

app.use(
  '/auth',
  authRouter({
    closeDeviceWs,
    closeDocWs,
    liveUserCount: (code) => roomStats.get(code)?.clients.size ?? 0,
  })
);
app.use('/auth/pair', pairRouter({ closeDeviceWs }));
app.use(
  '/docs',
  docsRouter({
    closeDocWs,
    listTrash,
  })
);

// 附件:上传按文档归属登记;读取免登录但校验文档状态(L10)
app.use('/', attachmentsRouter());

// L18:只回数量,绝不列出文档码(在线房间页签已删)
app.get('/health', (_req, res) => {
  const rooms = Array.from(roomStats.values());
  let docsCount = 0;
  try {
    docsCount = getDb().prepare("SELECT COUNT(*) AS n FROM docs WHERE status != 'purged'").get().n;
  } catch {
    /* db 不可用时健康检查仍应返回 */
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    totalRooms: rooms.length,
    totalUsers: rooms.reduce((sum, room) => sum + room.clients.size, 0),
    docs: docsCount,
    uploadsBytes: (() => {
      try {
        return getDb().prepare('SELECT COALESCE(SUM(size),0) AS n FROM attachments').get().n;
      } catch {
        return 0;
      }
    })(),
  });
});

// 静态前端(Vite 产物),与 WS 同端口同源。
// path.resolve:sendFile 要求绝对路径,避免 STATIC_DIR 传相对路径时 500
const staticDir = path.resolve(process.env.STATIC_DIR || path.join(__dirname, 'public'));
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  // 客户端路由兜底:先命中 <route>.html,再回落 index.html
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/uploads')) return next();
    const routePath = path.posix.normalize(req.path).replace(/\/+$/, '') || '/';
    if (routePath !== '/') {
      const candidate = path.join(staticDir, `${routePath}.html`);
      const staysInside = !path.relative(staticDir, candidate).startsWith('..');
      if (staysInside && fs.existsSync(candidate)) {
        return res.sendFile(candidate);
      }
    }
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

const httpServer = createServer(app);
// v4 凭据走 Sec-WebSocket-Protocol(设计 V12):只回显 polyphony.v1,绝不回显凭据;
// ?token= 查询参数回落随全新开始移除(不再进 URL/代理访问日志)。
const wss = new WebSocketServer({
  server: httpServer,
  handleProtocols: (protocols) => (protocols.has('polyphony.v1') ? 'polyphony.v1' : false),
});

/** 从请求的子协议列表取 `auth.<凭据>`;缺失返回空串。 */
function credentialFromSubprotocols(header) {
  const list = String(header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const auth = list.find((s) => s.startsWith('auth.'));
  return auth ? auth.slice('auth.'.length) : '';
}

wss.on('connection', (ws, req) => {
  const roomUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const session = authenticate(credentialFromSubprotocols(req.headers['sec-websocket-protocol']));
  if (!session) {
    ws.close(4001, 'unauthorized: credential required');
    return;
  }

  const roomCode = decodeURIComponent(roomUrl.pathname.slice(1) || 'default');

  // 文档门控(§4.4):不存在/已清除 4004;回收站 4010。此后 bindState 只会见登记过的码
  const gate = checkDocForConnection(roomCode);
  if (!gate.allowed) {
    ws.close(gate.closeCode, gate.reason);
    return;
  }

  trackWs(ws, session.device.id, roomCode);

  let roomData = roomStats.get(roomCode);
  if (!roomData) {
    roomData = { clients: new Set(), lastActivity: Date.now() };
    roomStats.set(roomCode, roomData);
  }
  roomData.clients.add(ws);
  roomData.lastActivity = Date.now();

  ws.on('message', () => {
    const room = roomStats.get(roomCode);
    if (room) room.lastActivity = Date.now();
  });

  ws.on('close', () => {
    const room = roomStats.get(roomCode);
    if (room) {
      room.clients.delete(ws);
      room.lastActivity = Date.now();
      if (room.clients.size === 0) roomStats.delete(roomCode);
    }
  });

  setupWSConnection(ws, req, { docName: roomCode, gc: true });
});

startSweeper();

const port = Number(process.env.PORT) || 3001;
httpServer.listen(port, () => {
  console.log(`[polyphony] server listening on port ${port}`);
});

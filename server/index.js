import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from 'y-websocket/bin/utils';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createAccount, verifyToken, enterRoom, leaveRooms, getRooms } from './auth.js';
import {
  createPairing,
  getPairingInfo,
  claimPairing,
  pollPairing,
  confirmPairing,
  cancelPairing,
  listPairings,
} from './pairing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// 确保上传文件夹存在
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 静态文件服务
app.use('/uploads', express.static(uploadsDir));

// ---------- 账号鉴权(token 全端通用;创建仅 Web/同源) ----------

/** 从 Authorization: Bearer xxx 取 token。 */
function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** 「仅 Web 端创建」= 拦 App(Tauri 自有 Origin),Web(同源/跨源 dev)/非浏览器工具放行。 */
function allowCreateOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl/node 等非浏览器客户端(冒烟/CLI)
  // Tauri WebView 的 Origin 形态:tauri://localhost 或 http(s)://tauri.localhost
  if (/^tauri:\/\//i.test(origin) || /^https?:\/\/tauri\.localhost/i.test(origin)) {
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  const account = verifyToken(bearerToken(req));
  if (!account) {
    return res.status(401).json({ error: '未登录或 token 无效', code: 'ERR_UNAUTHORIZED' });
  }
  req.account = account;
  next();
}

// 创建账号(Web 独占:同源校验)。token 明文仅在本次响应出现,服务端只存哈希。
app.post('/auth/create', (req, res) => {
  if (!allowCreateOrigin(req)) {
    return res.status(403).json({ error: '账号仅支持在 Web 端创建', code: 'ERR_WEB_ONLY' });
  }
  try {
    const { token, name } = createAccount(req.body?.name);
    res.status(201).json({ token, name });
  } catch (err) {
    res.status(422).json({ error: err.message, code: err.code || 'ERR_NAME_INVALID' });
  }
});

// 校验 token 并返回账号信息(登录/展示用)
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.account.id, name: req.account.name });
});

// 我的房间(服务端房间簿;合并 /health 的在线人数)
app.get('/rooms', requireAuth, (req, res) => {
  const rooms = getRooms(req.account.id).map((r) => {
    const live = roomStats.get(r.code);
    return { ...r, userCount: live ? live.clients.size : 0 };
  });
  res.json({ rooms });
});

// 进入/改名登记(upsert)
app.post('/rooms/enter', requireAuth, (req, res) => {
  const rooms = enterRoom(req.account.id, req.body?.code, req.body?.name).map((r) => {
    const live = roomStats.get(r.code);
    return { ...r, userCount: live ? live.clients.size : 0 };
  });
  res.json({ rooms });
});

// 批量退出(解除关联;房间内容不受影响)
app.post('/rooms/leave', requireAuth, (req, res) => {
  const rooms = leaveRooms(req.account.id, req.body?.codes).map((r) => {
    const live = roomStats.get(r.code);
    return { ...r, userCount: live ? live.clients.size : 0 };
  });
  res.json({ rooms });
});

// ---------- 配对登录(扫码/邀请链接;契约见 docs/pairing-login.md §4.2) ----------

// D15:含 token 的响应绝不可被中间盒/浏览器缓存
app.use('/auth/pair', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/** pairing 状态机错误码 → HTTP 状态;只打 code 前 6 位,不打完整 code/token。 */
function pairError(res, err) {
  const status =
    err.code === 'E_PAIR_EXPIRED' ? 410
    : err.code === 'E_PAIR_CLAIMED' || err.code === 'E_PAIR_STATE' ? 409
    : 400; // E_PAIR_KIND / E_PAIR_TOKEN
  res.status(status).json({ error: err.message, code: err.code });
}

const pairLog = (event, p, extra = '') =>
  console.log(
    `[pair] ${event} kind=${p.kind} code=${p.code.slice(0, 6)}… account=${p.accountName}${extra}`
  );

// 创建配对(QR 固定 2 分钟;链接 5/15/30/60 分钟档)
app.post('/auth/pair/create', requireAuth, (req, res) => {
  try {
    const kind = req.body?.kind;
    const p = createPairing(req.account, kind, req.body?.ttlMinutes);
    pairLog('create', { ...p, kind, accountName: req.account.name });
    res.status(201).json(p);
  } catch (err) {
    pairError(res, err);
  }
});

// 本账号全部未清扫配对(弹窗列表 + 红点;含终态供显示最终结果)
app.get('/auth/pair/status', requireAuth, (req, res) => {
  res.json({ pairings: listPairings(req.account.id) });
});

// 落地页预览(无鉴权;安全性由 128 位 code 熵承担)
app.get('/auth/pair/info', (req, res) => {
  try {
    res.json(getPairingInfo(String(req.query.code ?? '')));
  } catch (err) {
    pairError(res, err);
  }
});

// 认领(无鉴权):签发 claimKey,仅持钥者可 poll/取 token
app.post('/auth/pair/claim', (req, res) => {
  try {
    const result = claimPairing(
      String(req.body?.code ?? ''),
      req.headers['user-agent']
    );
    pairLog('claim', { kind: '?', code: String(req.body?.code), accountName: result.accountName },
      ` ua="${(req.headers['user-agent'] ?? '').slice(0, 60)}"`);
    res.json(result);
  } catch (err) {
    pairError(res, err);
  }
});

// 轮询(凭 code+claimKey):approved 首次命中交出 token(D15:POST,claimKey 不进 URL)
app.post('/auth/pair/poll', (req, res) => {
  try {
    res.json(pollPairing(String(req.body?.code ?? ''), String(req.body?.key ?? '')));
  } catch (err) {
    pairError(res, err);
  }
});

// 确认/拒绝(owner 专属):accept 时附上自己持有的明文 token 供中转(服务端只短暂驻留)
app.post('/auth/pair/confirm', requireAuth, (req, res) => {
  const code = String(req.body?.code ?? '');
  const accept = Boolean(req.body?.accept);
  const token = String(req.body?.token ?? '');
  if (accept) {
    const tokAccount = verifyToken(token);
    if (!tokAccount || tokAccount.id !== req.account.id) {
      return res
        .status(400)
        .json({ error: 'token 无效或不属于当前账号', code: 'E_PAIR_TOKEN' });
    }
  }
  try {
    const result = confirmPairing(code, req.account.id, accept, accept ? token : undefined);
    console.log(
      `[pair] confirm-${accept ? 'accept' : 'deny'} code=${code.slice(0, 6)}… account=${req.account.name}`
    );
    res.json(result);
  } catch (err) {
    pairError(res, err);
  }
});

// 撤销(owner 专属,pending/claimed/approved 均可):发错链接的救济通道(D11)
app.post('/auth/pair/cancel', requireAuth, (req, res) => {
  try {
    const result = cancelPairing(String(req.body?.code ?? ''), req.account.id);
    console.log(
      `[pair] cancel code=${String(req.body?.code).slice(0, 6)}… account=${req.account.name}`
    );
    res.json(result);
  } catch (err) {
    pairError(res, err);
  }
});


// 配置 multer 存储
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, 'image-' + uniqueSuffix + ext);
  },
});

// 文件过滤器：只允许图片（错误附稳定 code，客户端按 code 本地化；error 兼容旧客户端）
const fileFilter = (_req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const mimetype = allowedTypes.test(file.mimetype);
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());

  if (mimetype && extname) {
    return cb(null, true);
  }
  const err = new Error('只支持上传 jpg, jpeg, png, gif, webp 格式的图片');
  err.code = 'E_FILE_TYPE';
  cb(err);
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: fileFilter,
});

// 图片上传端点(需登录)
app.post('/upload', requireAuth, upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '没有上传文件', code: 'E_NO_FILE' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
  } catch (error) {
    console.error('图片上传失败:', error);
    res.status(500).json({ error: '图片上传失败', code: 'E_UPLOAD' });
  }
});

// 处理 multer 错误
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件大小不能超过 5MB', code: 'E_FILE_SIZE' });
    }
    return res.status(400).json({ error: err.message, code: 'E_UPLOAD' });
  } else if (err) {
    return res.status(400).json({ error: err.message, code: err.code || 'E_UPLOAD' });
  }
  next();
});

const roomStats = new Map();

app.get('/health', (_req, res) => {
  const rooms = Array.from(roomStats.entries()).map(([code, data]) => ({
    code,
    userCount: data.clients.size,
    lastActivity: data.lastActivity,
  }));

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    totalRooms: rooms.length,
    totalUsers: rooms.reduce((sum, room) => sum + room.userCount, 0),
    rooms,
  });
});

// 静态前端（Next.js 静态导出产物），与 WS 同端口同源，
// 适配 fnos connect 随机四级域名反代的场景
// path.resolve：sendFile 要求绝对路径，避免 STATIC_DIR 传相对路径时 500
const staticDir = path.resolve(process.env.STATIC_DIR || path.join(__dirname, 'public'));
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  // 客户端路由兜底，对齐 nginx 的 try_files $uri $uri.html $uri/ /index.html：
  // Next 静态导出把无扩展名路由生成为 <route>.html（如 editor.html），
  // 必须先命中它，否则 /editor 会错误地回落到首页 index.html
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/uploads')) return next();
    const routePath = path.posix.normalize(req.path).replace(/\/+$/, '') || '/';
    if (routePath !== '/') {
      const candidate = path.join(staticDir, `${routePath}.html`);
      const staysInside = !path
        .relative(staticDir, candidate)
        .startsWith('..');
      if (staysInside && fs.existsSync(candidate)) {
        return res.sendFile(candidate);
      }
    }
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const { url } = req;
  const roomUrl = new URL(
    url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`
  );

  // 强制鉴权:所有端用账号 token 登录(无 token/无效 → 拒绝)
  const account = verifyToken(roomUrl.searchParams.get('token') || '');
  if (!account) {
    ws.close(4001, 'unauthorized: token required');
    return;
  }

  const roomCode = decodeURIComponent(roomUrl.pathname.slice(1) || 'default');

  let roomData = roomStats.get(roomCode);
  if (!roomData) {
    roomData = { clients: new Set(), lastActivity: Date.now() };
    roomStats.set(roomCode, roomData);
  }

  roomData.clients.add(ws);
  roomData.lastActivity = Date.now();

  ws.on('message', () => {
    const room = roomStats.get(roomCode);
    if (room) {
      room.lastActivity = Date.now();
    }
  });

  ws.on('close', () => {
    const room = roomStats.get(roomCode);
    if (room) {
      room.clients.delete(ws);
      room.lastActivity = Date.now();

      if (room.clients.size === 0) {
        roomStats.delete(roomCode);
      }
    }
  });

  setupWSConnection(ws, req, {
    docName: roomCode,
    gc: true,
  });
});

const port = Number(process.env.PORT) || 3001;

httpServer.listen(port, () => {
  console.log(`[y-websocket] Server listening on port ${port}`);
});

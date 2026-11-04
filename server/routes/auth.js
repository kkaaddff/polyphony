// /auth/* 路由:契约见 docs/identity-and-sharing.md §4.4。
// deps 注入 WS 关闭能力(index.js 持有连接注册表),保持路由层无连接状态。
import { Router } from 'express';
import {
  createAccount,
  exchange,
  authenticate,
  listDevices,
  revokeDevice,
  regenerateRecovery,
  deleteAccount,
  restoreAccount,
} from '../auth.js';
import { listRooms, enterRoom, leaveRooms } from '../rooms.js';
import { countPendingPairings } from '../pairing.js';

/** 错误码 → HTTP 状态(统一 E_ 前缀;新增码时同步客户端 i18n 表)。 */
function sendErr(res, e) {
  const status =
    {
      E_UNAUTHORIZED: 401,
      E_NOT_FOUND: 404,
      E_NAME_INVALID: 422,
      E_NAME_TAKEN: 422,
      E_SECRET_INVALID: 400,
      E_NAME_MISMATCH: 400,
      E_DEVICE_LIMIT: 409,
      E_ACCOUNT_DELETED: 409,
      E_ACCOUNT_ACTIVE: 409,
      E_ACCOUNT_STATE: 409,
      E_DOC_MISSING: 404,
    }[e.code] ?? 500;
  const body = { error: e.message, code: e.code };
  if (e.purgeAt) body.purgeAt = e.purgeAt;
  res.status(status).json(body);
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

export function requireAuth(req, res, next) {
  const session = authenticate(bearerToken(req));
  if (!session) {
    return res.status(401).json({ error: '未登录或凭据无效', code: 'E_UNAUTHORIZED' });
  }
  req.account = session.account;
  req.device = session.device;
  next();
}

export function authRouter(deps) {
  const r = Router();

  // 创建账号:全端可用(V6,原 Origin 门控已删)。响应含一次性恢复密钥,绝不回显 secret。
  r.post('/create', (req, res) => {
    try {
      const result = createAccount(
        { name: req.body?.name, secret: req.body?.secret, platform: req.body?.platform },
        req.headers['user-agent']
      );
      console.log(`[auth] create ${result.name}`);
      res.status(201).json(result);
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 恢复密钥 → 兑换本机设备凭据
  r.post('/exchange', (req, res) => {
    try {
      const result = exchange(
        { key: req.body?.key, secret: req.body?.secret, platform: req.body?.platform },
        req.headers['user-agent']
      );
      console.log(`[auth] exchange ${result.name}`);
      res.json(result);
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 注销撤销(恢复密钥,无会话——注销后本就无设备可会话)
  r.post('/account/restore', (req, res) => {
    try {
      const result = restoreAccount(
        { key: req.body?.key, secret: req.body?.secret, platform: req.body?.platform },
        req.headers['user-agent']
      );
      console.log(`[auth] account-restore ${result.name}`);
      res.json(result);
    } catch (e) {
      sendErr(res, e);
    }
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ id: req.account.id, name: req.account.name, deviceId: req.device.id });
  });

  r.get('/devices', requireAuth, (req, res) => {
    res.json({ devices: listDevices(req.account.id, req.device.id) });
  });

  // 吊销设备(自己的任一设备;本机即退出登录)→ 立即断其 WS
  r.delete('/devices/:id', requireAuth, (req, res) => {
    const target = revokeDevice(String(req.params.id));
    if (!target || target.accountId !== req.account.id) {
      return sendErr(res, Object.assign(new Error('设备不存在'), { code: 'E_NOT_FOUND' }));
    }
    deps.closeDeviceWs([req.params.id]);
    console.log(`[auth] revoke ${req.account.name} ${String(req.params.id).slice(0, 8)}`);
    res.status(204).end();
  });

  // 退出登录 = 吊销本机
  r.post('/logout', requireAuth, (req, res) => {
    revokeDevice(req.device.id);
    deps.closeDeviceWs([req.device.id]);
    console.log(`[auth] logout ${req.account.name}`);
    res.status(204).end();
  });

  // 重新生成恢复密钥(旧的立即作废;响应仅此一次)
  r.post('/recovery/regenerate', requireAuth, (req, res) => {
    const recoveryKey = regenerateRecovery(req.account.id);
    console.log(`[auth] regenerate ${req.account.name}`);
    res.json({ recoveryKey });
  });

  // 注销账号:设备全吊销 + 自有文档进回收站 → 关闭设备 WS(4001)与文档 WS(4010)
  r.post('/account/delete', requireAuth, (req, res) => {
    try {
      const { deviceIds, docCodes } = deleteAccount({
        accountId: req.account.id,
        name: req.body?.name,
      });
      deps.closeDeviceWs(deviceIds);
      deps.closeDocWs(docCodes, 4010);
      console.log(`[auth] account-delete ${req.account.name} docs=${docCodes.length}`);
      res.status(204).end();
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ---- 房间簿(v3 同形接口;L2 随 docStore 最终化) ----

  r.get('/rooms', requireAuth, (req, res) => {
    const rooms = listRooms(req.account.id).map((x) => ({
      ...x,
      userCount: deps.liveUserCount(x.code),
    }));
    res.json({ rooms, pendingPairings: countPendingPairings(req.account.id) });
  });

  r.post('/rooms/enter', requireAuth, (req, res) => {
    try {
      enterRoom(req.account.id, req.body?.code);
      const rooms = listRooms(req.account.id).map((x) => ({
        ...x,
        userCount: deps.liveUserCount(x.code),
      }));
      res.json({ rooms, pendingPairings: countPendingPairings(req.account.id) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  r.post('/rooms/leave', requireAuth, (req, res) => {
    leaveRooms(req.account.id, req.body?.codes);
    const rooms = listRooms(req.account.id).map((x) => ({
      ...x,
      userCount: deps.liveUserCount(x.code),
    }));
    res.json({ rooms, pendingPairings: countPendingPairings(req.account.id) });
  });

  return r;
}

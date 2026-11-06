// /auth/pair/* 路由:契约见 docs/identity-and-sharing.md §4.4。
// 日志纪律:只打 code 前 6 位 + 账号名 + 方向,绝不打凭据/secret/完整 code/请求体。
import { Router } from 'express';
import {
  createPushPairing,
  requestPullPairing,
  getPairingInfo,
  claimPushPairing,
  approvePairing,
  pollPairing,
  cancelPairing,
  listPairingsForAccount,
} from '../pairing.js';
import { buildPendingDevice } from '../auth.js';
import { requireAuth } from './auth.js';

function sendErr(res, e) {
  const status =
    {
      E_PAIR_EXPIRED: 410,
      E_PAIR_CLAIMED: 409,
      E_PAIR_STATE: 409,
      E_PAIR_KIND: 400,
      E_PAIR_DIRECTION: 400,
      E_PAIR_BUSY: 503,
      E_DEVICE_LIMIT: 409,
      E_SECRET_INVALID: 400,
    }[e.code] ?? 500;
  res.status(status).json({ error: e.message, code: e.code });
}

const pairLog = (event, code, extra = '') =>
  console.log(`[pair] ${event} code=${String(code).slice(0, 6)}…${extra}`);

export function pairRouter(deps) {
  const r = Router();

  const ua = (req) => req.headers['user-agent'] ?? '';

  // push:已登录端发起(一个配对码同出二维码与链接;TTL 5/15/30/60 分钟档,默认 5)
  r.post('/create', requireAuth, (req, res) => {
    try {
      const p = createPushPairing(req.account, req.body?.ttlMinutes);
      pairLog('create', p.code, ` push ttl=${req.body?.ttlMinutes || 5}m account=${req.account.name}`);
      res.status(201).json(p);
    } catch (e) {
      sendErr(res, e);
    }
  });

  // pull:新设备发起本机二维码(无鉴权;全局上限 E_PAIR_BUSY)
  r.post('/request', (req, res) => {
    try {
      const pending = buildPendingDevice(req.body?.secret, req.body?.platform, ua(req));
      const p = requestPullPairing(pending);
      pairLog('request', p.code, ` pull label=${pending.label}`);
      res.status(201).json(p);
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 落地页预览(无鉴权;pull 不暴露账号信息)
  r.get('/info', (req, res) => {
    try {
      res.json(getPairingInfo(String(req.query.code ?? '')));
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 认领(仅 push;无鉴权;新设备本地 secret 登记哈希,拿 deviceId)
  r.post('/claim', (req, res) => {
    try {
      const pending = buildPendingDevice(req.body?.secret, req.body?.platform, ua(req));
      const result = claimPushPairing(String(req.body?.code ?? ''), pending);
      pairLog('claim', req.body?.code, ` push label=${pending.label}`);
      res.json(result);
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 批准/拒绝(会话;该账号任一设备均可,V11;批准即写入设备)
  r.post('/approve', requireAuth, (req, res) => {
    const code = String(req.body?.code ?? '');
    const accept = Boolean(req.body?.accept);
    try {
      const result = approvePairing({ code, account: req.account, accept });
      pairLog(accept ? 'approve' : 'deny', code, ` ${result.status === 'denied' ? 'denied' : 'approved'} account=${req.account.name}`);
      res.json(result);
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 轮询(新设备;幂等、无秘密)
  r.post('/poll', (req, res) => {
    try {
      res.json(pollPairing({ code: req.body?.code, deviceId: req.body?.deviceId }));
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 撤销(push 发起账号;approved 记录撤销时连带吊销已写入设备)
  r.post('/cancel', requireAuth, (req, res) => {
    try {
      const result = cancelPairing({ code: String(req.body?.code ?? ''), accountId: req.account.id });
      pairLog('cancel', req.body?.code, ` account=${req.account.name}`);
      if (result.revokedDeviceId) deps.closeDeviceWs([result.revokedDeviceId]);
      res.json(result);
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 本账号全部未清扫配对(弹窗列表 + 红点)
  r.get('/status', requireAuth, (req, res) => {
    res.json({ pairings: listPairingsForAccount(req.account.id) });
  });

  return r;
}

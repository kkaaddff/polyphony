// /docs/* 路由:契约见 docs/document-lifecycle.md §4.3。
// 「成员」= 任何已登录且知道码的账号(房间码仍是通行码,§10 遗留)。
import { Router } from 'express';
import crypto from 'crypto';
import {
  getDocRow,
  createDoc,
  trashDoc,
  restoreDoc,
  purgeDoc,
} from '../docStore.js';
import { buildExportZip, contentDisposition } from '../exporter.js';
import { requireAuth } from './auth.js';

// 一次性导出令牌(60s,用后即焚,纯内存)
const EXPORT_TOKEN_MS = 60_000;
const exportTokens = new Map(); // token → { code, accountId, exp }
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of exportTokens) if (v.exp < now) exportTokens.delete(t);
}, 30_000).unref();

function sendErr(res, e) {
  const status =
    {
      E_NOT_OWNER: 403,
      E_DOC_STATE: 409,
      E_DOC_MISSING: 404,
    }[e.code] ?? 500;
  res.status(status).json({ error: e.message, code: e.code });
}

function publicStatus(row) {
  // purged 与不存在同为 missing;trashed 对所有者可见详情
  if (!row || row.status === 'purged') return 'missing';
  return row.status;
}

export function docsRouter(deps) {
  const r = Router();

  // 新建:服务端生成码,创建者即所有者;docs+owner 成员关系同一事务
  r.post('/', requireAuth, (req, res) => {
    const { code } = createDoc({ ownerId: req.account.id, name: req.body?.name });
    console.log(`[docs] create ${code} owner=${req.account.name}`);
    res.status(201).json({ code });
  });

  // 进入前检查(不认领、不创建;missing 不区分 purged/不存在)
  r.get('/:code', requireAuth, (req, res) => {
    const row = getDocRow(req.params.code);
    const status = publicStatus(row);
    res.json({
      status,
      isOwner: Boolean(row && row.owner_id === req.account.id && status !== 'missing'),
      name: status === 'missing' ? '' : row.name,
    });
  });

  // 删除(所有者):active → trashed,立即断开在线连接(4010)
  r.delete('/:code', requireAuth, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    try {
      const row = getDocRow(code);
      if (!row || row.status !== 'active') throw Object.assign(new Error('文档不存在'), { code: 'E_DOC_MISSING' });
      if (row.owner_id !== req.account.id) throw Object.assign(new Error('只有所有者能删除文档'), { code: 'E_NOT_OWNER' });
      trashDoc(code, 'owner');
      deps.closeDocWs([code], 4010, 'doc trashed');
      console.log(`[docs] trash ${code} reason=owner by=${req.account.name}`);
      res.status(204).end();
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 恢复(所有者,回收站内)
  r.post('/:code/restore', requireAuth, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    try {
      const row = getDocRow(code);
      if (!row || row.status === 'purged') throw Object.assign(new Error('文档不存在'), { code: 'E_DOC_MISSING' });
      if (row.owner_id !== req.account.id) throw Object.assign(new Error('只有所有者能恢复文档'), { code: 'E_NOT_OWNER' });
      restoreDoc(code);
      console.log(`[docs] restore ${code} by=${req.account.name}`);
      res.status(204).end();
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 立即清除(所有者,回收站内;不可撤销,连带附件)
  r.post('/:code/purge', requireAuth, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    try {
      const row = getDocRow(code);
      if (!row || row.status !== 'trashed') throw Object.assign(new Error('文档不在回收站'), { code: 'E_DOC_MISSING' });
      if (row.owner_id !== req.account.id) throw Object.assign(new Error('只有所有者能清除文档'), { code: 'E_NOT_OWNER' });
      purgeDoc(code);
      deps.closeDocWs([code], 4004, 'doc purged');
      console.log(`[docs] purge ${code} by=${req.account.name}`);
      res.status(204).end();
    } catch (e) {
      sendErr(res, e);
    }
  });

  // 申请一次性导出链接(active 任何成员;trashed 仅所有者)
  r.post('/:code/export-link', requireAuth, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const row = getDocRow(code);
    if (!row || row.status === 'purged') {
      return res.status(404).json({ error: '文档不存在', code: 'E_DOC_MISSING' });
    }
    if (row.status === 'trashed' && row.owner_id !== req.account.id) {
      return res.status(403).json({ error: '只有所有者能导出回收站中的文档', code: 'E_NOT_OWNER' });
    }
    const token = crypto.randomUUID();
    exportTokens.set(token, { code, exp: Date.now() + EXPORT_TOKEN_MS });
    res.json({ url: `/docs/${code}/export?t=${token}`, expiresAt: Date.now() + EXPORT_TOKEN_MS });
  });

  // zip 下载(令牌校验:60s、一次性)
  r.get('/:code/export', (req, res) => {
    const t = String(req.query.t ?? '');
    const v = exportTokens.get(t);
    exportTokens.delete(t); // 用后即焚(无论成败)
    const code = String(req.params.code).toUpperCase();
    if (!v || v.code !== code || v.exp < Date.now()) {
      return res.status(410).json({ error: '导出链接已失效,请重新申请', code: 'E_EXPORT_EXPIRED' });
    }
    const bundle = buildExportZip(code);
    if (!bundle) return res.status(404).json({ error: '文档不存在', code: 'E_DOC_MISSING' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', contentDisposition(bundle.filename));
    res.end(Buffer.from(bundle.zip));
    console.log(`[docs] export ${code}`);
  });

  // 回收站列表(本账号为所有者)
  r.get('/trash/list', requireAuth, (req, res) => {
    const rows = deps
      .listTrash(req.account.id)
      .map((x) => ({ ...x, purgeAt: x.trashedAt + 30 * 24 * 3600 * 1000 }));
    res.json({ docs: rows });
  });

  return r;
}

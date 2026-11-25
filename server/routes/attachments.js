// 附件路由(docs/document-lifecycle.md §4.3):
// - POST /docs/:code/attachments:上传(会话,文档须 active;客户端已重新编码去元数据/压缩)
// - GET  /uploads/:code/:file:读取(免登录,<img> 无法带凭据;靠 128-bit 熵 + 文档状态校验)
import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db.js';
import { getDocRow } from '../docStore.js';
import { registerAttachment, resolveAttachment, newAttachmentFilename } from '../attachments.js';
import { uploadsDir } from '../resetV3.js';
import { requireAuth } from './auth.js';

const ALLOWED = /jpe?g|png|gif|webp/;

export function attachmentsRouter() {
  const r = Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const code = String(req.params.code ?? '').toUpperCase();
        const dir = path.join(uploadsDir(), code);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        cb(null, newAttachmentFilename(file.originalname));
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED.test(file.mimetype) && ALLOWED.test(path.extname(file.originalname).toLowerCase())) {
        return cb(null, true);
      }
      const err = new Error('只支持上传 jpg, jpeg, png, gif, webp 格式的图片');
      err.code = 'E_FILE_TYPE';
      cb(err);
    },
  });

  r.post('/docs/:code/attachments', requireAuth, (req, res) => {
    const code = String(req.params.code ?? '').toUpperCase();
    const row = getDocRow(code);
    if (!row || row.status === 'purged') {
      return res.status(404).json({ error: '文档不存在', code: 'E_DOC_MISSING' });
    }
    if (row.status !== 'active') {
      return res.status(410).json({ error: '文档已在回收站', code: 'E_DOC_TRASHED' });
    }
    upload.single('image')(req, res, (err) => {
      if (err) {
        const code2 = err.code === 'LIMIT_FILE_SIZE' ? 'E_FILE_SIZE' : err.code || 'E_UPLOAD';
        const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件大小不能超过 5MB' : err.message;
        return res.status(400).json({ error: msg, code: code2 });
      }
      if (!req.file) {
        return res.status(400).json({ error: '没有上传文件', code: 'E_NO_FILE' });
      }
      const key = registerAttachment({
        docCode: code,
        filename: req.file.filename,
        size: req.file.size,
        uploaderId: req.account.id,
      });
      res.status(201).json({ url: `/uploads/${key}` });
    });
  });

  r.get('/uploads/:code/:file', (req, res) => {
    const p = resolveAttachment(String(req.params.code ?? '').toUpperCase(), String(req.params.file ?? ''));
    if (!p) return res.status(404).end();
    // L10:仅查看者本机缓存、最长 1 天,删除后残留可控
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(p);
  });

  return r;
}

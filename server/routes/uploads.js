// 图片上传(v3 形态的过渡移植:L3 将替换为 POST /docs/:code/attachments,
// 见 docs/document-lifecycle.md §4.3)。鉴权改走 v4 设备会话。
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadsDir } from '../resetV3.js';
import { requireAuth } from './auth.js';

export function uploadsRouter() {
  const r = Router();
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, 'image-' + uniqueSuffix + path.extname(file.originalname));
    },
  });

  // 只允许图片(错误附稳定 code,客户端按 code 本地化)
  const fileFilter = (_req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    if (allowedTypes.test(file.mimetype) && allowedTypes.test(path.extname(file.originalname).toLowerCase())) {
      return cb(null, true);
    }
    const err = new Error('只支持上传 jpg, jpeg, png, gif, webp 格式的图片');
    err.code = 'E_FILE_TYPE';
    cb(err);
  };

  const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter });

  r.post('/upload', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '没有上传文件', code: 'E_NO_FILE' });
    }
    res.json({ url: `/uploads/${req.file.filename}` });
  });

  // multer 错误归一(大小超限给稳定 code)
  r.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'E_FILE_SIZE' : 'E_UPLOAD';
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件大小不能超过 5MB' : err.message;
      return res.status(400).json({ error: msg, code });
    }
    if (err) {
      return res.status(400).json({ error: err.message, code: err.code || 'E_UPLOAD' });
    }
    next();
  });

  return r;
}

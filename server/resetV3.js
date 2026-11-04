// v4 全新开始(docs/identity-and-sharing.md §6):检测 v3 数据 → 同卷 rename 归档,不复制、不删除。
// 判定:polyphony.db 已存在 = 已是 v4,不动作;否则 accounts.json 存在、
// 或 uploads 根目录有散落文件(v3 平铺图片)即触发归档。幂等。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dataDir } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function uploadsDir() {
  return process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
}

/** 把一个目录下的“文件”(不含子目录,v4 只用子目录)移入归档目录。 */
function archiveFlatFiles(dir, archiveDir) {
  let moved = 0;
  if (!fs.existsSync(dir)) return moved;
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    const from = path.join(dir, entry);
    if (fs.statSync(from).isFile()) {
      fs.renameSync(from, path.join(archiveDir, entry));
      moved += 1;
    }
  }
  return moved;
}

/**
 * 归档 v3 数据。显式传 { dataDir, uploadsDir } 供测试;生产在 index.js 启动时调用。
 * 返回 { archived: bool, detail } 便于测试与日志。
 */
export function runResetV3(opts = {}) {
  const dir = opts.dataDir ?? dataDir();
  const upDir = opts.uploadsDir ?? uploadsDir();
  const dbFile = path.join(dir, 'polyphony.db');
  if (fs.existsSync(dbFile)) return { archived: false, reason: 'already-v4' };

  const accountsFile = path.join(dir, 'accounts.json');
  const hasV3Accounts = fs.existsSync(accountsFile);
  const hasFlatUploads =
    fs.existsSync(upDir) &&
    fs.readdirSync(upDir).some((e) => fs.statSync(path.join(upDir, e)).isFile());
  if (!hasV3Accounts && !hasFlatUploads) return { archived: false, reason: 'no-v3-data' };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const detail = { accounts: false, uploads: 0 };
  if (hasV3Accounts) {
    fs.mkdirSync(path.join(dir, `_v3-archive-${ts}`), { recursive: true });
    fs.renameSync(accountsFile, path.join(dir, `_v3-archive-${ts}`, 'accounts.json'));
    detail.accounts = true;
  }
  detail.uploads = archiveFlatFiles(upDir, path.join(upDir, `_v3-archive-${ts}`));

  console.log(
    `[reset] v3 data archived to _v3-archive-${ts} (accounts=${detail.accounts}, uploads=${detail.uploads})`
  );
  return { archived: true, detail, archive: `_v3-archive-${ts}` };
}

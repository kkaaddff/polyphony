// 导出打包(docs/document-lifecycle.md §4.7,L14):服务端 fflate 出 zip,
// <文档名>.md + images/;正文中的附件地址(任意协议/主机前缀)改写为 images/<文件名>;
// 中文文件名走 filename* 百分号编码。
import { zipSync } from 'fflate';
import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { readDocForExport } from './docStore.js';
import { attachmentPath } from './attachments.js';

const ATTACHMENT_URL_RE = /(?:https?:\/\/[^)\s]*)?\/uploads\/([A-Z0-9]{8})\/([a-f0-9]{32}\.(?:jpe?g|png|gif|webp))/g;
const FILENAME_SAFE_RE = /[\\/:*?"<>|\x00-\x1f]/g;

/** 生成导出 zip Buffer;文档不存在返回 null。 */
export function buildExportZip(code) {
  const docCode = String(code ?? '').toUpperCase();
  const doc = readDocForExport(docCode);
  if (!doc) return null;

  const db = getDb();
  const images = {};
  const usedNames = new Set();
  const md = doc.text.replace(ATTACHMENT_URL_RE, (_m, _c, file) => {
    const p = attachmentPath(`${_c}/${file}`);
    if (!fs.existsSync(p)) return file; // 缺失文件跳过,保留名字提示
    let name = file;
    let i = 1;
    while (usedNames.has(name)) name = `${i++}-${file}`; // 同名(不同扩展)冲突时加序号
    usedNames.add(name);
    images[`images/${name}`] = new Uint8Array(fs.readFileSync(p));
    return `images/${name}`;
  });

  const safeName = (doc.name || docCode).replace(FILENAME_SAFE_RE, '_').slice(0, 40) || docCode;
  const files = {
    [`${safeName}.md`]: new Uint8Array(Buffer.from(md, 'utf-8')),
    ...images,
  };
  return { zip: zipSync(files), filename: `${safeName}.zip` };
}

/** Content-Disposition:ASCII 回落名 + filename* UTF-8 百分号编码。 */
export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

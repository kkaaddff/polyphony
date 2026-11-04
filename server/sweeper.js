// 统一清扫调度器(每小时,unref):设备孤儿/不活动随本文件;
// 文档清扫与注销 30 天到期清除在 L1 接入同一个定时器(docs/document-lifecycle.md §4.6)。
import { sweepDevices } from './auth.js';

let timer = null;

export function startSweeper(intervalMs = 3600_000) {
  if (timer) return;
  const run = () => {
    try {
      const r = sweepDevices(Date.now());
      if (r.orphan || r.inactive) {
        console.log(`[auth] sweep orphan=${r.orphan} inactive=${r.inactive}`);
      }
    } catch (e) {
      console.error('[sweeper]', e.message);
    }
  };
  timer = setInterval(run, intervalMs);
  timer.unref();
}

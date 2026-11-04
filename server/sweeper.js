// 统一清扫调度器(每小时,unref):设备孤儿/不活动随本文件;
// 文档清扫与注销 30 天到期清除在 L1 接入同一个定时器(docs/document-lifecycle.md §4.6)。
import { sweepDevices } from './auth.js';
import { sweepDocs } from './docStore.js';

let timer = null;

export function startSweeper(intervalMs = 3600_000) {
  if (timer) return;
  const run = () => {
    try {
      const d = sweepDevices(Date.now());
      if (d.orphan || d.inactive) {
        console.log(`[auth] sweep orphan=${d.orphan} inactive=${d.inactive}`);
      }
      const doc = sweepDocs(Date.now());
      if (doc.inactive || doc.purged) {
        console.log(`[docs] sweep inactive=${doc.inactive} purged=${doc.purged} accounts=${doc.accounts}`);
      }
    } catch (e) {
      console.error('[sweeper]', e.message);
    }
  };
  timer = setInterval(run, intervalMs);
  timer.unref();
}

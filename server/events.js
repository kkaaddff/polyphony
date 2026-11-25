// 账号级事件推送(WS /_events,以及输入通道的发送端连接):目前只有「便签有变化」。
// 只发信号不发内容 —— 客户端收到后自己重新拉取 /notes。纯内存,不落库。
export const EVENTS_PATH = '/_events';

export function createEventHub() {
  /** accountId → Set<ws> */
  const byAccount = new Map();

  return {
    /** 登记一条已鉴权连接;断开自动移除。 */
    attach(ws, accountId) {
      let set = byAccount.get(accountId);
      if (!set) byAccount.set(accountId, (set = new Set()));
      set.add(ws);
      ws.on('close', () => {
        set.delete(ws);
        if (set.size === 0 && byAccount.get(accountId) === set) byAccount.delete(accountId);
      });
    },
    /** 推给该账号的全部连接(含发起变更的那台:客户端按 id 去重)。 */
    publish(accountId, event) {
      const data = JSON.stringify({ v: 1, ...event });
      for (const ws of byAccount.get(accountId) ?? []) {
        if (ws.readyState === 1) ws.send(data);
      }
    },
    _accountCount: () => byAccount.size,
  };
}

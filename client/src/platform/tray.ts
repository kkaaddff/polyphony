// 桌面托盘桥：最近房间 + 当前语言推给 Rust 重建菜单；订阅托盘动作导航。
// 仅在 isTauri() 为真时调用（Web 下 invoke 无接收端）。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RecentRoom } from "@/types";

/** 最近房间/语言变化时推给 Rust 重建托盘菜单（最多 5 条，Rust 侧同样截断）。 */
export function pushRecentRooms(rooms: RecentRoom[], locale: string): void {
  void invoke("set_recent_rooms", {
    rooms: rooms.slice(0, 5).map(({ code, name }) => ({ code, name })),
    locale,
  }).catch(console.error);
}

export type TrayAction = { type: "new" } | { type: "open"; code: string } | { type: "notes" };

/** 订阅托盘动作（新建房间 / 直达房间）；返回取消函数。 */
export async function onTrayAction(
  handler: (action: TrayAction) => void
): Promise<() => void> {
  const unNew = await listen("tray://new-room", () =>
    handler({ type: "new" })
  );
  const unOpen = await listen<string>("tray://open-room", (e) =>
    handler({ type: "open", code: e.payload })
  );
  const unNotes = await listen("tray://open-notes", () => handler({ type: "notes" }));
  return () => {
    unNew();
    unOpen();
    unNotes();
  };
}

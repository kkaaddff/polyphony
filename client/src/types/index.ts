// 用户信息（awareness presence）
export interface User {
  id: string;
  name: string;
  color?: string;
  /** 客户端标签,如 "App · Android" / "Chrome · macOS"(旧客户端不带) */
  client?: string;
  /** awareness clientID:每个连接唯一,同账号多端时作列表 key */
  clientId?: number;
  /** 是否本连接 */
  isSelf?: boolean;
}

// 本地「最近房间」记录（localStorage 快照）
export interface RecentRoom {
  code: string; // 不可变加入钥匙
  name: string; // 最近一次同步到的共享名快照（可能为 ""）
  lastUsed: number; // 时间戳，用于排序
}

// 服务端房间簿条目(GET /rooms:memberships ⨝ docs + 实时在线数)
export interface MyRoom {
  code: string;
  name: string;
  lastUsed: number;
  userCount: number;
  status: "active" | "trashed";
  isOwner: boolean;
  /** 正文开头的纯文本(未命名时代替标题显示;旧服务端不带) */
  preview?: string;
}

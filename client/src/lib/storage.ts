// 纯客户端 localStorage 工具：最近房间列表 + 通用同步 hook
// （用户名经 useLocalStorageState(USERNAME_KEY) 持久化）。
// 所有读写都带 SSR 守卫与 try/catch 降级（隐私模式 / 解析失败不致崩溃）。

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { RecentRoom } from "@/types";

// localStorage key（导出供 hook 调用方复用，避免魔法字符串）
export const USERNAME_KEY = "polyphony.username";
const RECENT_ROOMS_KEY = "polyphony.recentRooms";
const MAX_RECENT_ROOMS = 20;

/**
 * 读取已保存用户名（裸字符串读取 + JSON 解析双兼容）。
 * useLocalStorageState 以 JSON.stringify 写入；直接 getItem 会拿到带引号的
 * `"张三"`——扫码落地页等不经 hook 读取的场景必须走这里。
 */
export function getSavedUsername(): string {
  try {
    const raw = window.localStorage.getItem(USERNAME_KEY) ?? "";
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return raw; // 兼容历史裸字符串写入
    }
  } catch {
    return "";
  }
}

// ---------- 最近房间 ----------

export function getRecentRooms(): RecentRoom[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_ROOMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentRoom =>
          r && typeof r.code === "string" && typeof r.name === "string"
      )
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  } catch {
    return [];
  }
}

function saveRecentRooms(rooms: RecentRoom[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      RECENT_ROOMS_KEY,
      JSON.stringify(rooms.slice(0, MAX_RECENT_ROOMS))
    );
  } catch {
    /* 忽略 */
  }
}

/** 新增或更新一条最近房间（按 code 去重，刷新 name 与 lastUsed）。 */
export function upsertRecentRoom(entry: { code: string; name: string }): void {
  if (typeof window === "undefined") return;
  if (!entry.code) return;
  const rooms = getRecentRooms().filter((r) => r.code !== entry.code);
  rooms.unshift({
    code: entry.code,
    name: entry.name,
    lastUsed: Date.now(),
  });
  saveRecentRooms(rooms);
}

export function removeRecentRoom(code: string): void {
  if (typeof window === "undefined") return;
  saveRecentRooms(getRecentRooms().filter((r) => r.code !== code));
}

// ---------- 通用 hook ----------

// 同标签页写入通知（storage 事件只跨标签页触发，本页写完要自己广播）
const sameTabBus = new EventTarget();

/** 订阅某个 localStorage key 的变化（同标签页 + 跨标签页）；i18n 等模块复用。 */
export function listenKey(key: string, onChange: () => void): () => void {
  const onBus = () => onChange();
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === key) onChange();
  };
  sameTabBus.addEventListener(key, onBus);
  window.addEventListener("storage", onStorage);
  return () => {
    sameTabBus.removeEventListener(key, onBus);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * 与 localStorage 同步的 state（useSyncExternalStore 实现）。
 * 静态导出/SSR 安全：服务端快照恒为 initial，水合后自动切换真实值。
 * 同标签页写入即时生效，跨标签页经 storage 事件同步。
 */
export function useLocalStorageState<T>(
  key: string,
  initial: T
): [T, (value: T | ((prev: T) => T)) => void] {
  // 快照缓存：raw 未变则复用上次引用，保证 getSnapshot 引用稳定
  const cacheRef = useRef<{ raw: string | null; value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      raw = null;
    }
    let cache = cacheRef.current;
    if (!cache || cache.raw !== raw) {
      let value = initial;
      if (raw != null) {
        try {
          value = JSON.parse(raw) as T;
        } catch {
          /* 解析失败回退 initial */
        }
      }
      cache = { raw, value };
      cacheRef.current = cache;
    }
    return cache.value;
  }, [key, initial]);

  const subscribe = useCallback(
    (onChange: () => void) => listenKey(key, onChange),
    [key]
  );

  const value = useSyncExternalStore(subscribe, getSnapshot, () => initial);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = getSnapshot();
      const resolved =
        typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        /* 忽略写入失败（隐私模式等） */
      }
      sameTabBus.dispatchEvent(new CustomEvent(key));
    },
    [key, getSnapshot]
  );

  return [value, update];
}

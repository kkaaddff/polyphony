// 应用壳上下文:首页 / 设置 / 语音便签共用同一份文档状态(useDocsStore)。
// 侧栏在任何一页都要有文档列表、离线态、账号与弹层,故状态上提到壳,页面经 useShell() 取用。
import { createContext, useContext } from "react";
import type { DocsStore } from "@/lib/useDocsStore";

export const ShellContext = createContext<DocsStore | null>(null);

export function useShell(): DocsStore {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell 必须在 <AppShell> 内使用");
  return ctx;
}

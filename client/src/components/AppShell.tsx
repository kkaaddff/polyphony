// 应用壳(v5):桌面 = 全高侧栏 + 主区;移动 = 整页(无侧栏)。
// 首页 / 设置 / 语音便签都在壳内,共用 useDocsStore 的文档列表、离线态、账号与弹层。
// 登录守卫也在这里:无凭据一律去 /welcome,原地址放 ?next=。
import { Navigate, Outlet, useLocation } from "react-router";
import { getToken } from "@/lib/auth";
import { useDocsStore } from "@/lib/useDocsStore";
import { useIsMobile } from "@/lib/useIsMobile";
import { ShellContext } from "./shellContext";
import { Sidebar } from "./Sidebar";
import { ShellModals } from "./ShellModals";

export function AppShell() {
  const location = useLocation();
  if (!getToken()) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/welcome?next=${next}`} replace />;
  }
  return <ShellInner />;
}

function ShellInner() {
  const store = useDocsStore();
  const isMobile = useIsMobile();
  return (
    <ShellContext.Provider value={store}>
      {isMobile ? (
        <Outlet />
      ) : (
        <div className="grid h-dvh box-border grid-cols-[272px_minmax(0,1fr)] overflow-hidden bg-paper pt-[env(safe-area-inset-top)]">
          <Sidebar />
          <main className="flex min-h-0 min-w-0 flex-col">
            <Outlet />
          </main>
        </div>
      )}
      <ShellModals />
    </ShellContext.Provider>
  );
}

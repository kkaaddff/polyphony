import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { isDesktopTauri } from "@/platform";
import { onTrayAction } from "@/platform/tray";
import { ensureAutostartDefault } from "@/platform/autostart";
import { getToken } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import Home from "@/pages/Home";
import Editor from "@/pages/Editor";
import Settings from "@/pages/Settings";
import Notes from "@/pages/Notes";
import Join from "@/pages/Join";
import Pair from "@/pages/Pair";
import Welcome from "@/pages/Welcome";

/** 登录守卫:无 token 一律去 /welcome,原地址放 ?next= 供登录后回跳。 */
function RequireToken({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!getToken()) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/welcome?next=${next}`} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  const navigate = useNavigate();
  // 托盘「语音便签」:在任何页面都直达便签页
  useEffect(() => {
    if (!isDesktopTauri()) return;
    void ensureAutostartDefault();
    let disposed = false;
    let un: (() => void) | undefined;
    void onTrayAction((action) => {
      if (action.type === "notes") void navigate("/notes");
    }).then((u) => (disposed ? u() : (un = u)));
    return () => {
      disposed = true;
      un?.();
    };
  }, [navigate]);

  return (
    <Routes>
      <Route path="/welcome" element={<Welcome />} />
      {/* 应用壳:首页 / 设置 / 语音便签共用侧栏与文档状态(壳内自带登录守卫) */}
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/notes" element={<Notes />} />
      </Route>
      <Route
        path="/editor"
        element={
          <RequireToken>
            <Editor />
          </RequireToken>
        }
      />
      <Route path="/join" element={<Join />} />
      <Route path="/pair" element={<Pair />} />
    </Routes>
  );
}

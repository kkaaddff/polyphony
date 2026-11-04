import { Navigate, Route, Routes, useLocation } from "react-router";
import { getToken } from "@/lib/auth";
import Home from "@/pages/Home";
import Editor from "@/pages/Editor";
import Settings from "@/pages/Settings";
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
  return (
    <Routes>
      <Route path="/welcome" element={<Welcome />} />
      <Route
        path="/"
        element={
          <RequireToken>
            <Home />
          </RequireToken>
        }
      />
      <Route
        path="/editor"
        element={
          <RequireToken>
            <Editor />
          </RequireToken>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireToken>
            <Settings />
          </RequireToken>
        }
      />
      <Route path="/join" element={<Join />} />
      <Route path="/pair" element={<Pair />} />
    </Routes>
  );
}

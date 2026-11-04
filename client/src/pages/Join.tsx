// /join?code=XXXX&server=http://...  扫码落地页。
// 固化 server 配置后:无 token → 带 next 去 /welcome 登录;有 token →
// 取账号名直进编辑器(名字不再依赖本地手填)。
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { saveServer } from "@/lib/serverConfig";
import { getToken, verifyLogin } from "@/lib/auth";
import { useT } from "@/i18n";

export default function Join() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useT();
  const [message, setMessage] = useState(() => t("join.entering"));

  useEffect(() => {
    const server = searchParams.get("server");
    // slice(0,8) 与首页输入框 maxLength 对齐:超长码截断,保证与手输路径同房间
    const code = (searchParams.get("code") ?? "").trim().toUpperCase().slice(0, 8);
    if (server) saveServer(server);

    if (!code) {
      navigate("/", { replace: true });
      return;
    }

    const enter = (name: string) =>
      navigate(
        `/editor?code=${code}&name=${encodeURIComponent(name)}`,
        { replace: true }
      );

    if (!getToken()) {
      // 未登录:登录后回到本落地页继续进房
      const next = encodeURIComponent(`/join?code=${code}${server ? `&server=${encodeURIComponent(server)}` : ""}`);
      navigate(`/welcome?next=${next}`, { replace: true });
      return;
    }

    verifyLogin(getToken())
      .then((acc) => enter(acc.name))
      .catch(() => {
        setMessage(t("join.needName"));
        navigate(`/?join=${code}`, { replace: true });
      });
  }, [searchParams, navigate, t]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center pt-[env(safe-area-inset-top)] box-border">
      <p className="text-gray-500 text-sm">{message}</p>
    </div>
  );
}

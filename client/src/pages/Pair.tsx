// /pair?code=&server= 配对登录落地页(系统相机扫 QR / 点邀请链接兜底)。
// 显式按钮才 claim(防手滑烧码);claim 后轮询等发起端确认;成功提示网页版/App 区别。
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getServerBase, saveServer } from "@/lib/serverConfig";
import { setToken } from "@/lib/auth";
import { claimPairing, pairInfo, pollPairing, formatRemain } from "@/lib/pairing";
import { useT } from "@/i18n";

type ErrorKind = "invalid" | "expired" | "denied" | "cancelled" | "network";

type View =
  | { step: "loading" }
  | { step: "preview"; accountName: string; expiresAt: number }
  | { step: "claimed" }
  | { step: "waiting"; accountName: string; expiresAt: number }
  | { step: "success"; accountName: string }
  | { step: "error"; kind: ErrorKind };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Pair() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useT();
  const [view, setView] = useState<View>({ step: "loading" });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pollStopped = useRef(false);
  // 微信内点链接登录的是微信浏览器,装了 App 的用户最易混淆 → 成功页专门提示
  const isMobileUa = /android|iphone|ipad|mobi/i.test(navigator.userAgent);

  const code = (searchParams.get("code") ?? "").trim();
  const next = searchParams.get("next") || "/";

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 终态跳转动作(成功页手动按钮,避免用户错过网页版/App 提示)
  const enter = () => navigate(next, { replace: true });

  // 引导:固化 server → info 预览;非 pending(已用/终态)给出对应提示
  useEffect(() => {
    pollStopped.current = false;
    const server = searchParams.get("server");
    if (server) saveServer(server);
    if (!code) {
      setView({ step: "error", kind: "invalid" });
      return;
    }
    pairInfo(getServerBase(), code)
      .then((info) => {
        if (pollStopped.current) return;
        if (info.status === "pending") {
          setView({ step: "preview", accountName: info.accountName, expiresAt: info.expiresAt });
        } else {
          // claimed/approved:已被别的设备领走
          setView({ step: "claimed" });
        }
      })
      .catch(() => {
        if (!pollStopped.current) setView({ step: "error", kind: "invalid" });
      });
    return () => {
      pollStopped.current = true;
    };
  }, [code]);

  // claim 后轮询:前 30s 每 1.5s,后退避 5s(长 TTL 链接可能等几分钟才确认)
  const startPolling = async (claimKey: string, expiresAt: number) => {
    const startedAt = Date.now();
    while (!pollStopped.current) {
      await sleep(Date.now() - startedAt < 30_000 ? 1500 : 5000);
      if (pollStopped.current) return;
      try {
        const r = await pollPairing(getServerBase(), code, claimKey);
        if (r.status === "approved") {
          setToken(r.token);
          setView({ step: "success", accountName: r.account.name });
          return;
        }
        if (r.status === "denied") {
          setView({ step: "error", kind: "denied" });
          return;
        }
        if (r.status === "cancelled") {
          setView({ step: "error", kind: "cancelled" });
          return;
        }
        if (Date.now() > expiresAt) {
          setView({ step: "error", kind: "expired" });
          return;
        }
      } catch {
        setView({ step: "error", kind: "expired" });
        return;
      }
    }
  };

  const loginHere = async () => {
    setBusy(true);
    try {
      const r = await claimPairing(getServerBase(), code);
      setView({ step: "waiting", accountName: r.accountName, expiresAt: r.expiresAt });
      void startPolling(r.claimKey, r.expiresAt);
    } catch (e) {
      const errCode = (e as { code?: string }).code;
      if (errCode === "E_PAIR_CLAIMED") setView({ step: "claimed" });
      else setView({ step: "error", kind: errCode === "E_PAIR_EXPIRED" ? "invalid" : "network" });
    } finally {
      setBusy(false);
    }
  };

  const errorText = (kind: ErrorKind) => {
    switch (kind) {
      case "denied":
        return t("pairPage.deniedTitle");
      case "cancelled":
        return t("pairPage.cancelledTitle");
      default:
        return t("pairPage.invalid");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] box-border">
      <div className="max-w-sm w-full bg-white rounded-2xl shadow-2xl p-8 text-center space-y-4">
        {view.step === "loading" && <p className="text-gray-500 text-sm">…</p>}

        {view.step === "preview" && (
          <>
            <h1 className="text-xl font-bold text-gray-900">{t("pairPage.previewTitle")}</h1>
            <p className="text-sm text-gray-700">
              {t("pairPage.loginAs", { name: view.accountName })}
            </p>
            <p className="text-xs text-gray-400">
              {t("pairPage.remainTime", { time: formatRemain(view.expiresAt, now) })}
            </p>
            <button
              onClick={loginHere}
              disabled={busy}
              className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg disabled:opacity-50"
            >
              {t("pairPage.loginHereBtn")}
            </button>
          </>
        )}

        {view.step === "claimed" && (
          <p className="text-sm text-gray-700 py-4">{t("pairPage.claimedNotice")}</p>
        )}

        {view.step === "waiting" && (
          <>
            <h1 className="text-xl font-bold text-gray-900">{t("pairPage.waitingTitle")}</h1>
            <p className="text-sm text-gray-700">
              {t("pairPage.waitingFor", { name: view.accountName })}
            </p>
            <p className="text-3xl font-mono font-bold text-blue-600">
              {formatRemain(view.expiresAt, now)}
            </p>
            <div className="size-8 mx-auto rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin" />
          </>
        )}

        {view.step === "success" && (
          <>
            <h1 className="text-xl font-bold text-green-600">{t("pairPage.successTitle")}</h1>
            <p className="text-sm text-gray-700">
              {t("pairPage.successAs", { name: view.accountName })}
            </p>
            {isMobileUa && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
                {t("pairPage.webOnlyHint")}
              </p>
            )}
            <button
              onClick={enter}
              className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg"
            >
              {t("pairPage.enterBtn")}
            </button>
          </>
        )}

        {view.step === "error" && (
          <p className="text-sm text-red-600 py-4">{errorText(view.kind)}</p>
        )}
      </div>
    </div>
  );
}

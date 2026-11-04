// /pair?code=&server= 配对落地页(双向,docs/identity-and-sharing.md §4.6):
// push(已登录端出的码/链接):新设备预览 → 显式按钮 claim(防手滑烧码)→ 轮询等确认。
// pull(新设备本机码):已登录端打开 = 批准页(设备名+醒目警示,V8);未登录提示用已登录设备扫。
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getServerBase, saveServer } from "@/lib/serverConfig";
import { getToken } from "@/lib/auth";
import { pairInfo, claimPairing, pollPairing, finalizePairing, approvePairing, formatRemain } from "@/lib/pairing";
import { useT } from "@/i18n";

type ErrorKind = "invalid" | "expired" | "denied" | "cancelled" | "network";

type View =
  | { step: "loading" }
  | { step: "preview"; accountName: string; expiresAt: number }
  | { step: "claimed" }
  | { step: "waiting"; accountName: string; expiresAt: number }
  | { step: "success"; accountName: string }
  | { step: "approve"; newcomerLabel: string; expiresAt: number }
  | { step: "needLogin" }
  | { step: "done"; accepted: boolean }
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

  const enter = () => navigate(next, { replace: true });

  // 引导:固化 server → info 按 direction 分支
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
        if (info.direction === "pull") {
          // 已登录 → 批准页;未登录 → 引导用已登录设备扫
          if (getToken().startsWith("poly_d_")) {
            if (info.status === "pending") {
              setView({ step: "approve", newcomerLabel: info.newcomerLabel ?? "", expiresAt: info.expiresAt });
            } else {
              setView({ step: "error", kind: "expired" });
            }
          } else {
            setView({ step: "needLogin" });
          }
          return;
        }
        // push:pending 预览;其余(已认领/终态)提示
        if (info.status === "pending") {
          setView({ step: "preview", accountName: info.accountName, expiresAt: info.expiresAt });
        } else {
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

  // push claim 后轮询:前 30s 每 1.5s,后退避 5s(长 TTL 链接可能等几分钟才确认)
  const startPolling = async (deviceId: string, secret: string, expiresAt: number) => {
    const startedAt = Date.now();
    while (!pollStopped.current) {
      await sleep(Date.now() - startedAt < 30_000 ? 1500 : 5000);
      if (pollStopped.current) return;
      try {
        const r = await pollPairing(getServerBase(), code, deviceId);
        if (r.status === "approved") {
          await finalizePairing(getServerBase(), deviceId, secret);
          setView({ step: "success", accountName: r.accountName ?? "" });
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
        // 记录可能已被清扫:本地凭据直接验一次(V2)
        try {
          await finalizePairing(getServerBase(), deviceId, secret);
          setView({ step: "success", accountName: "" });
        } catch {
          setView({ step: "error", kind: "expired" });
        }
        return;
      }
    }
  };

  const loginHere = async () => {
    setBusy(true);
    try {
      const r = await claimPairing(getServerBase(), code);
      setView({ step: "waiting", accountName: r.accountName, expiresAt: r.expiresAt });
      void startPolling(r.deviceId, r.secret, r.expiresAt);
    } catch (e) {
      const errCode = (e as { code?: string }).code;
      if (errCode === "E_PAIR_CLAIMED") setView({ step: "claimed" });
      else setView({ step: "error", kind: errCode === "E_PAIR_EXPIRED" ? "invalid" : "network" });
    } finally {
      setBusy(false);
    }
  };

  // pull 批准/拒绝(服务端拼的设备名是唯一防钓鱼锚点,V8)
  const decide = async (accept: boolean) => {
    setBusy(true);
    try {
      await approvePairing(code, accept);
      setView({ step: "done", accepted: accept });
    } catch {
      setView({ step: "error", kind: "expired" });
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
            {view.accountName && (
              <p className="text-sm text-gray-700">
                {t("pairPage.successAs", { name: view.accountName })}
              </p>
            )}
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

        {view.step === "approve" && (
          <>
            <h1 className="text-xl font-bold text-gray-900">{t("pairPage.approveTitle")}</h1>
            <p className="text-base text-gray-900 font-semibold">
              {t("pairPage.approveWho", { label: view.newcomerLabel })}
            </p>
            <p className="text-xs text-gray-400">
              {t("pairPage.remainTime", { time: formatRemain(view.expiresAt, now) })}
            </p>
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 leading-relaxed text-left">
              {t("pairPage.approveWarn")}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void decide(false)}
                disabled={busy}
                className="flex-1 py-3 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 disabled:opacity-50"
              >
                {t("pairPage.denyBtn")}
              </button>
              <button
                onClick={() => void decide(true)}
                disabled={busy}
                className="flex-1 py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 disabled:opacity-50"
              >
                {t("pairPage.approveBtn")}
              </button>
            </div>
          </>
        )}

        {view.step === "needLogin" && (
          <p className="text-sm text-gray-700 py-4">{t("pairPage.needLogin")}</p>
        )}

        {view.step === "done" && (
          <>
            <h1 className="text-xl font-bold text-gray-900">
              {view.accepted ? t("pairPage.doneAccepted") : t("pairPage.doneDenied")}
            </h1>
            <button
              onClick={() => navigate("/", { replace: true })}
              className="w-full py-3 rounded-lg bg-gray-900 text-white text-sm font-semibold hover:bg-gray-700 transition-colors"
            >
              {t("pairPage.backHome")}
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

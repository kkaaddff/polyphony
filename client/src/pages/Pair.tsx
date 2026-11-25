// /pair?code=&server= 配对落地页(双向,docs/identity-and-sharing.md §4.6):
// push(已登录端出的码/链接):新设备预览 → 显式按钮 claim → 轮询等确认。
// pull(新设备本机码):已登录端打开 = 批准页(设备名+醒目警示);未登录提示用已登录设备扫。
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getServerBase, saveServer } from "@/lib/serverConfig";
import { getToken } from "@/lib/auth";
import { pairInfo, claimPairing, pollPairing, finalizePairing, approvePairing, formatRemain, PAIR_RESULT_LINGER_MS } from "@/lib/pairing";
import { useT } from "@/i18n";
import { LogoMark } from "@/components/icons";
import { Button, Callout } from "@/components/ui";

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
  const isMobileUa = /android|iphone|ipad|mobi/i.test(navigator.userAgent);

  const code = (searchParams.get("code") ?? "").trim();
  const next = searchParams.get("next") || "/";

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const enter = () => navigate(next, { replace: true });

  // 有了结果(本机登录成功 / 已批准或拒绝对方)就不停在这页:提示停留片刻自动离开。
  // 手机浏览器登录成功时多留一会儿——那条「这是网页版,App 里要另行配对」的提示得让人看完。
  const settled = view.step === "success" ? "success" : view.step === "done" ? "done" : "";
  const leaveRef = useRef<(to: string) => void>(() => undefined);
  leaveRef.current = (to) => navigate(to, { replace: true });
  const nextRef = useRef(next);
  nextRef.current = next;
  useEffect(() => {
    if (!settled) return;
    const linger = settled === "success" && isMobileUa ? PAIR_RESULT_LINGER_MS * 2.5 : PAIR_RESULT_LINGER_MS;
    const id = window.setTimeout(() => leaveRef.current(settled === "success" ? nextRef.current : "/"), linger);
    return () => window.clearTimeout(id);
  }, [settled, isMobileUa]);

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

  const remain = (expiresAt: number) => (
    <p className="text-xs text-ink-3">{t("pairPage.remainTime", { time: formatRemain(expiresAt, now) })}</p>
  );

  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper p-4 pt-[calc(env(safe-area-inset-top)+16px)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-20 bg-sheet p-7 text-center shadow-md">
        <LogoMark className="size-9 rounded-[9px]" />
        {view.step === "loading" && <p className="text-sm text-ink-3">…</p>}

        {view.step === "preview" && (
          <>
            <h1 className="text-xl font-bold text-ink">{t("pairPage.previewTitle")}</h1>
            <p className="text-sm text-ink-2">{t("pairPage.loginAs", { name: view.accountName })}</p>
            {remain(view.expiresAt)}
            <Button variant="primary" size="lg" onClick={() => void loginHere()} disabled={busy} className="w-full">
              {t("pairPage.loginHereBtn")}
            </Button>
          </>
        )}

        {view.step === "claimed" && <p className="py-4 text-sm text-ink-2">{t("pairPage.claimedNotice")}</p>}

        {view.step === "waiting" && (
          <>
            <h1 className="text-xl font-bold text-ink">{t("pairPage.waitingTitle")}</h1>
            <p className="text-sm text-ink-2">{t("pairPage.waitingFor", { name: view.accountName })}</p>
            <p className="font-display text-[44px] leading-none text-accent tabular-nums">{formatRemain(view.expiresAt, now)}</p>
            <div className="size-8 animate-spin rounded-full border-4 border-accent-100 border-t-accent-600" />
          </>
        )}

        {view.step === "success" && (
          <>
            <h1 className="text-xl font-bold text-ok">{t("pairPage.successTitle")}</h1>
            {view.accountName && <p className="text-sm text-ink-2">{t("pairPage.successAs", { name: view.accountName })}</p>}
            {isMobileUa && <Callout tone="warn">{t("pairPage.webOnlyHint")}</Callout>}
            <Button variant="primary" size="lg" onClick={enter} className="w-full">{t("pairPage.enterBtn")}</Button>
          </>
        )}

        {view.step === "approve" && (
          <>
            <h1 className="text-xl font-bold text-ink">{t("pairPage.approveTitle")}</h1>
            <p className="text-base font-semibold text-ink">{t("pairPage.approveWho", { label: view.newcomerLabel })}</p>
            {remain(view.expiresAt)}
            <Callout tone="danger" className="text-left">{t("pairPage.approveWarn")}</Callout>
            <div className="flex w-full gap-2">
              <Button variant="secondary" size="lg" onClick={() => void decide(false)} disabled={busy} className="flex-1">
                {t("pairPage.denyBtn")}
              </Button>
              <Button variant="primary" size="lg" onClick={() => void decide(true)} disabled={busy} className="flex-1">
                {t("pairPage.approveBtn")}
              </Button>
            </div>
          </>
        )}

        {view.step === "needLogin" && <p className="py-4 text-sm text-ink-2">{t("pairPage.needLogin")}</p>}

        {view.step === "done" && (
          <>
            <h1 className="text-xl font-bold text-ink">{view.accepted ? t("pairPage.doneAccepted") : t("pairPage.doneDenied")}</h1>
            <Button variant="secondary" size="lg" onClick={() => navigate("/", { replace: true })} className="w-full">
              {t("pairPage.backHome")}
            </Button>
          </>
        )}

        {view.step === "error" && <Callout tone="danger">{errorText(view.kind)}</Callout>}
      </div>
    </div>
  );
}

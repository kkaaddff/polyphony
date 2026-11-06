// 首次引导(v4 三入口,docs/identity-and-sharing.md §4.6):
// ① 创建账号(全端)→ 恢复密钥只显示一次;② 从已登录设备登录(本机二维码/扫码/粘贴链接);
// ③ 使用恢复密钥(次要)。无凭据的任何路由都会被重定向到这里,?next= 携带回跳目标。
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getSavedServer, getServerBase, saveServer } from "@/lib/serverConfig";
import { createAccount, exchangeRecovery, restoreDeletedAccount } from "@/lib/auth";
import { buildPairUrl, renderQr } from "@/lib/qr";
import { parseIntake } from "@/lib/intake";
import {
  claimPairing,
  pollPairing,
  finalizePairing,
  requestPullPairing,
  formatRemain,
} from "@/lib/pairing";
import { ScanModal } from "@/components/ScanModal";
import { isTauri } from "@/platform";
import { useT } from "@/i18n";

type Tab = "create" | "device" | "recovery";

// push 配对(扫码/粘贴链接)流程视图
type PairErrorKind = "claimed" | "invalid" | "denied" | "cancelled" | "network";
type PairView =
  | { step: "claiming" }
  | { step: "waiting"; accountName: string; expiresAt: number }
  | { step: "error"; kind: PairErrorKind };

// 恢复密钥登录的错误形态
type RecoveryError = { kind: "invalid" | "network" | "deleted"; purgeAt?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Welcome() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useT();
  const next = searchParams.get("next") || "/";

  const app = isTauri();
  const [tab, setTab] = useState<Tab>(app ? "device" : "create");
  // Web 下默认填当前实际地址(同源部署=origin,dev=VITE_SERVER_URL),免去手抄;
  // Tauri 无 origin 概念,保持手填。保存过配置则始终优先展示已保存值。
  const [server, setServer] = useState(() => getSavedServer() || (app ? "" : getServerBase()));
  const [name, setName] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 创建成功 → 恢复密钥页(V3/V19:只显示一次,勾选「已妥善保存」才能继续)
  const [created, setCreated] = useState<{ recoveryKey: string; name: string } | null>(null);
  const [savedAck, setSavedAck] = useState(false);
  const [copied, setCopied] = useState(false);

  // push 配对 / 扫码弹层 / 房间码暂存回跳
  const [pairView, setPairView] = useState<PairView | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [nextOverride, setNextOverride] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const pairStopped = useRef(false);

  // pull 本机二维码(反向配对):tab=device 且未在 push 流程时展示
  const [pull, setPull] = useState<{
    code: string;
    deviceId: string;
    secret: string;
    expiresAt: number;
  } | null>(null);
  const [pullBusy, setPullBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => () => { pairStopped.current = true; }, []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const goNext = () => navigate(nextOverride ?? next, { replace: true });

  // ---------- pull:本机二维码(手机已登录、这台新设备要登录的最短路径) ----------

  const refreshPull = async () => {
    setPullBusy(true);
    try {
      const base = getServerBase();
      const r = await requestPullPairing(base);
      setPull(r);
    } catch {
      setPull(null);
    } finally {
      setPullBusy(false);
    }
  };

  useEffect(() => {
    if (tab !== "device" || pairView) return;
    void refreshPull();
  }, [tab, pairView]);

  // pull 轮询:1.5s→30s 后 5s;tab 隐藏时暂停(资源与滥用面)
  useEffect(() => {
    if (tab !== "device" || !pull || pairView) return;
    pairStopped.current = false;
    const startedAt = Date.now();
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(tick, 5000);
        return;
      }
      try {
        const r = await pollPairing(getServerBase(), pull.code, pull.deviceId);
        if (r.status === "approved") {
          await finalizePairing(getServerBase(), pull.deviceId, pull.secret);
          goNext();
          return;
        }
        if (r.status === "denied") {
          setScanNotice(t("pairPage.deniedTitle"));
          void refreshPull();
          return;
        }
      } catch {
        // 过期/网络:重建请求继续等
        void refreshPull();
        return;
      }
      timer = window.setTimeout(tick, Date.now() - startedAt < 30_000 ? 1500 : 5000);
    };
    timer = window.setTimeout(tick, 1500);
    return () => {
      pairStopped.current = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [tab, pull, pairView]);

  // 二维码渲染(过期自动刷新:每次 refreshPull 换新 secret)
  useEffect(() => {
    if (pull && canvasRef.current) {
      renderQr(canvasRef.current, buildPairUrl(getServerBase(), pull.code)).catch(console.error);
    }
  }, [pull]);

  // ---------- push:扫码/粘贴链接 → claim → 等确认 ----------

  const runPairPoll = async (base: string, code: string, deviceId: string, secret: string, expiresAt: number) => {
    const startedAt = Date.now();
    while (!pairStopped.current) {
      await sleep(Date.now() - startedAt < 30_000 ? 1500 : 5000);
      if (pairStopped.current) return;
      try {
        const r = await pollPairing(base, code, deviceId);
        if (r.status === "approved") {
          await finalizePairing(base, deviceId, secret);
          goNext();
          return;
        }
        if (r.status === "denied") {
          setPairView({ step: "error", kind: "denied" });
          return;
        }
        if (r.status === "cancelled") {
          setPairView({ step: "error", kind: "cancelled" });
          return;
        }
        if (Date.now() > expiresAt) {
          setPairView({ step: "error", kind: "invalid" });
          return;
        }
      } catch {
        // 记录可能已被清扫:本地凭据直接验一次(V2)
        try {
          await finalizePairing(base, deviceId, secret);
          goNext();
        } catch {
          setPairView({ step: "error", kind: "invalid" });
        }
        return;
      }
    }
  };

  const startPair = async (base: string, code: string) => {
    setPairView({ step: "claiming" });
    try {
      const r = await claimPairing(base, code);
      setPairView({ step: "waiting", accountName: r.accountName, expiresAt: r.expiresAt });
      void runPairPoll(base, code, r.deviceId, r.secret, r.expiresAt);
    } catch (e) {
      const errCode = (e as { code?: string }).code;
      setPairView({
        step: "error",
        kind:
          errCode === "E_PAIR_CLAIMED"
            ? "claimed"
            : errCode === "E_PAIR_EXPIRED"
              ? "invalid"
              : "network",
      });
    }
  };

  const handleScanResult = (text: string) => {
    setScanOpen(false);
    setScanNotice("");
    const intake = parseIntake(text);
    if (!intake) {
      setScanNotice(t("home.alertInvalidQr"));
      return;
    }
    if (intake.type === "pair") {
      if (intake.server) saveServer(intake.server);
      void startPair(intake.server ?? getServerBase(), intake.code);
      return;
    }
    if (intake.type === "join") {
      const params = new URLSearchParams({ code: intake.code });
      if (intake.server) params.set("server", intake.server);
      setNextOverride(`/join?${params.toString()}`);
      setScanNotice(t("welcome.pairScannedRoom"));
      return;
    }
    // 分享本站 → 固化 server 后停留
    saveServer(intake.server);
    setScanNotice(t("welcome.serverSaved"));
  };

  const pairErrorText = (kind: PairErrorKind) => {
    switch (kind) {
      case "claimed":
        return t("errors.E_PAIR_CLAIMED");
      case "denied":
        return t("pairPage.deniedTitle");
      case "cancelled":
        return t("pairPage.cancelledTitle");
      case "network":
        return t("welcome.errNetwork");
      default:
        return t("pairPage.invalid");
    }
  };

  // ---------- 创建 / 恢复密钥 ----------

  const handleCreate = async () => {
    setBusy(true);
    setError("");
    try {
      const acc = await createAccount(server, name.trim());
      setCreated({ recoveryKey: acc.recoveryKey, name: acc.name });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "E_NAME_TAKEN") setError(t("welcome.errNameTaken"));
      else if (code === "E_NAME_INVALID") setError(t("welcome.errNameInvalid"));
      else setError(t("welcome.errNetwork"));
    } finally {
      setBusy(false);
    }
  };

  const [recoveryError, setRecoveryError] = useState<RecoveryError | null>(null);

  const handleRecovery = async () => {
    setBusy(true);
    setRecoveryError(null);
    try {
      await exchangeRecovery(server, recoveryInput.trim());
      goNext();
    } catch (e) {
      const err = e as { code?: string; purgeAt?: number };
      if (err.code === "E_ACCOUNT_DELETED") {
        setRecoveryError({ kind: "deleted", purgeAt: err.purgeAt });
      } else if (err.code === "E_UNAUTHORIZED") {
        setRecoveryError({ kind: "invalid" });
      } else {
        setRecoveryError({ kind: "network" });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreDeleted = async () => {
    setBusy(true);
    try {
      await restoreDeletedAccount(server, recoveryInput.trim());
      goNext();
    } catch {
      setRecoveryError({ kind: "network" });
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    if (!created) return;
    const { copyText } = await import("@/lib/clipboard");
    if (await copyText(created.recoveryKey)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // ---------- 视图:push 配对流程 ----------
  if (pairView) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] box-border">
        <div className="max-w-xl w-full bg-white rounded-2xl shadow-2xl p-8 text-center space-y-4">
          {pairView.step === "claiming" && <p className="text-gray-500 text-sm py-8">…</p>}
          {pairView.step === "waiting" && (
            <>
              <h1 className="text-xl font-bold text-gray-900">{t("pairPage.waitingTitle")}</h1>
              <p className="text-sm text-gray-700">
                {t("pairPage.waitingFor", { name: pairView.accountName })}
              </p>
              <p className="text-3xl font-mono font-bold text-blue-600">
                {formatRemain(pairView.expiresAt, now)}
              </p>
              <div className="size-8 mx-auto rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin" />
            </>
          )}
          {pairView.step === "error" && (
            <>
              <p className="text-sm text-red-600 py-4">{pairErrorText(pairView.kind)}</p>
              <button
                onClick={() => setPairView(null)}
                className="w-full py-3 rounded-lg bg-gray-900 text-white text-sm font-semibold hover:bg-gray-700 transition-colors"
              >
                {t("common.close")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ---------- 视图:恢复密钥一次性展示(V19) ----------
  if (created) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] box-border">
        <div className="max-w-xl w-full bg-white rounded-2xl shadow-2xl p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">{t("welcome.recoveryTitle")}</h1>
          <p className="text-sm text-gray-600 mb-6">
            {t("welcome.recoveryNameLabel")}：<span className="font-semibold">{created.name}</span>
          </p>
          <div className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 mb-4 text-sm text-amber-800">
            ⚠️ {t("welcome.recoveryWarn")}
          </div>
          <div className="rounded-xl bg-gray-900 px-4 py-4 mb-4 flex items-center gap-3">
            <code className="flex-1 text-green-300 font-mono text-sm break-all select-all">
              {created.recoveryKey}
            </code>
            <button
              onClick={copyKey}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs font-medium hover:bg-white/20 transition-colors"
            >
              {copied ? t("welcome.copied") : t("welcome.copy")}
            </button>
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-700 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={savedAck}
              onChange={(e) => setSavedAck(e.target.checked)}
              className="mt-0.5 size-4 accent-blue-600"
            />
            {t("welcome.recoveryAck")}
          </label>
          <button
            onClick={goNext}
            disabled={!savedAck}
            className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg disabled:opacity-50"
          >
            {t("welcome.confirmBtn")}
          </button>
        </div>
      </div>
    );
  }

  // ---------- 视图:三入口表单 ----------
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "create", label: t("welcome.createTab") },
    { key: "device", label: t("welcome.deviceTab") },
    { key: "recovery", label: t("welcome.recoveryTab") },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] box-border">
      <div className="max-w-xl w-full">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">{t("welcome.title")}</h1>
          <p className="text-sm text-gray-600">{t("welcome.subtitle")}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl p-8 space-y-6">
          <div className="flex gap-2">
            {tabs.map((x) => (
              <button
                key={x.key}
                onClick={() => {
                  setTab(x.key);
                  setError("");
                  setRecoveryError(null);
                }}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  tab === x.key
                    ? "bg-blue-50 border-blue-400 text-blue-700"
                    : "border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {x.label}
              </button>
            ))}
          </div>

          {tab === "create" && (
            <div className="space-y-4">
              <div>
                <label htmlFor="accountName" className="block text-sm font-medium text-gray-700 mb-2">
                  {t("welcome.nameLabel")}
                </label>
                <input
                  id="accountName"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("welcome.namePlaceholder")}
                  maxLength={20}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>
              <button
                onClick={handleCreate}
                disabled={busy || !name.trim()}
                className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg disabled:opacity-50"
              >
                {t("welcome.createBtn")}
              </button>
            </div>
          )}

          {tab === "device" && (
            <div className="space-y-4">
              {/* 移动端:扫码在上;桌面:本机二维码在上(桌面没有摄像头) */}
              <div className={app ? "flex flex-col-reverse gap-4" : "flex flex-col gap-4"}>
                <div className="text-center space-y-2">
                  <p className="text-sm font-medium text-gray-700">{t("welcome.pullTitle")}</p>
                  {pull ? (
                    <>
                      <div className="flex justify-center">
                        <canvas ref={canvasRef} className="rounded-lg border border-gray-100" />
                      </div>
                      <p className="text-xs text-gray-400">
                        {t("welcome.pullRemain", { time: formatRemain(pull.expiresAt, now) })}
                      </p>
                    </>
                  ) : (
                    <button
                      onClick={() => void refreshPull()}
                      disabled={pullBusy}
                      className="text-sm text-blue-600 hover:underline disabled:opacity-50"
                    >
                      {pullBusy ? "…" : t("welcome.pullRefresh")}
                    </button>
                  )}
                  <p className="text-xs text-gray-500 leading-relaxed">{t("welcome.pullHint")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setScanOpen(true)}
                  className="w-full py-2.5 min-h-tap-44 rounded-lg border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50 transition-colors"
                >
                  {t("welcome.scanLoginBtn")}
                </button>
              </div>
              {scanNotice && <p className="text-xs text-blue-600 break-words">{scanNotice}</p>}
            </div>
          )}

          {tab === "recovery" && (
            <div className="space-y-4">
              <div>
                <label htmlFor="recoveryKey" className="block text-sm font-medium text-gray-700 mb-2">
                  {t("welcome.recoveryInputLabel")}
                </label>
                <input
                  id="recoveryKey"
                  type="text"
                  value={recoveryInput}
                  onChange={(e) => setRecoveryInput(e.target.value)}
                  placeholder="poly_r_…"
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-sm"
                />
              </div>
              <button
                onClick={handleRecovery}
                disabled={busy || !recoveryInput.trim()}
                className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg disabled:opacity-50"
              >
                {t("welcome.recoveryGoBtn")}
              </button>
              {recoveryError?.kind === "invalid" && (
                <p className="text-sm text-red-600">{t("welcome.errInvalidToken")}</p>
              )}
              {recoveryError?.kind === "network" && (
                <p className="text-sm text-red-600">{t("welcome.errNetwork")}</p>
              )}
              {recoveryError?.kind === "deleted" && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 space-y-2">
                  <p>{t("welcome.accountDeleting")}</p>
                  <button
                    onClick={handleRestoreDeleted}
                    disabled={busy}
                    className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
                  >
                    {t("welcome.accountRestoreBtn")}
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* 服务器地址:次要配置放卡片底部(Web 已默认填充当前地址;二维码/主操作优先占首屏) */}
          <div className="border-t border-gray-100 pt-5">
            <label htmlFor="server" className="block text-sm font-medium text-gray-700 mb-2">
              {t("welcome.serverLabel")}
            </label>
            <input
              id="server"
              type="text"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="https://docs.example.com"
              spellCheck={false}
              autoComplete="off"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-2">{t("welcome.serverHint")}</p>
          </div>
        </div>
      </div>

      {scanOpen && (
        <ScanModal onResult={handleScanResult} onClose={() => setScanOpen(false)} />
      )}
    </div>
  );
}

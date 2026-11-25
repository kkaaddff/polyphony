// 首次引导(v5,docs/identity-and-sharing.md §4.6):桌面左品牌右表单的分栏 hero;移动紧凑表单。
// ① 创建账号 → 恢复密钥只显示一次;② 从已登录设备登录(本机二维码/扫码/粘贴链接);③ 恢复密钥。
// 无凭据的任何路由都会被重定向到这里,?next= 携带回跳目标。
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getDefaultServer, getSavedServer, getServerBase, saveServer } from "@/lib/serverConfig";
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
import { Icon, LogoMark } from "@/components/icons";
import { Button, Callout, Dialog, Segmented, Select, cx, inputClass } from "@/components/ui";
import { isTauri } from "@/platform";
import { useLocalePref, useT, type LocalePref } from "@/i18n";

type Tab = "create" | "device" | "recovery";

type PairErrorKind = "claimed" | "invalid" | "denied" | "cancelled" | "network";
type PairView =
  | { step: "claiming" }
  | { step: "waiting"; accountName: string; expiresAt: number }
  | { step: "error"; kind: PairErrorKind };

type RecoveryError = { kind: "invalid" | "network" | "deleted" | "deviceLimit"; purgeAt?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 品牌区底部的声部辫:三条正弦带(白 / 天蓝 / 白)靠深色 halo 做上下穿插。 */
function braidPath(phase: number, width = 600, amp = 34, mid = 70): string {
  let d = "";
  for (let x = 0; x <= width; x += 6) {
    const y = mid + amp * Math.sin((x / 150) * Math.PI * 2 + phase);
    d += `${x ? " L" : "M"}${x} ${y.toFixed(1)}`;
  }
  return d;
}
const BRAID = [
  { phase: 0, stroke: "#f8fafc" },
  { phase: (Math.PI * 2) / 3, stroke: "#7dd3fc" },
  { phase: (Math.PI * 4) / 3, stroke: "#f8fafc" },
];

function BrandHero() {
  return (
    <aside className="relative hidden overflow-hidden bg-[linear-gradient(155deg,#5148ea_0%,#3730a3_52%,#1e1b4b_100%)] text-white md:flex md:flex-col md:px-12 md:py-11">
      <div className="relative z-[1] flex items-center gap-2.5">
        <LogoMark className="size-7 rounded-[7px]" />
        <span className="font-display text-[22px] font-medium tracking-[-0.02em]">Polyphony</span>
      </div>
      <div className="relative z-[1] mt-auto mb-[190px]">
        <p className="font-display text-[64px] leading-[1.02] font-normal italic tracking-[-0.025em]">
          Many voices.
          <br />
          <span className="text-[#7dd3fc] not-italic">One score.</span>
        </p>
        <p className="mt-4 max-w-[22em] text-15 leading-relaxed text-white/72">
          多个独立声部各行其是,没有中央指挥,却收敛为一份和谐的总谱。实时协同,打开即写,断网不慌。
        </p>
      </div>
      <svg
        viewBox="0 0 600 140"
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-[9%] -left-[6%] z-0 w-[112%]"
      >
        <g fill="none" strokeLinecap="round">
          {BRAID.map((w) => (
            <path key={`h${w.phase}`} d={braidPath(w.phase)} stroke="#1e1b4b" strokeOpacity="0.88" strokeWidth="15" />
          ))}
          {BRAID.map((w) => (
            <path key={w.phase} d={braidPath(w.phase)} stroke={w.stroke} strokeWidth="9.5" />
          ))}
        </g>
      </svg>
    </aside>
  );
}

export default function Welcome() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useT();
  const next = searchParams.get("next") || "/";

  const app = isTauri();
  const [tab, setTab] = useState<Tab>(app ? "device" : "create");
  const [server, setServer] = useState(() => getSavedServer() || (app ? getDefaultServer() : getServerBase()));
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [name, setName] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [created, setCreated] = useState<{ recoveryKey: string; name: string } | null>(null);
  const [savedAck, setSavedAck] = useState(false);
  const [copied, setCopied] = useState(false);

  const [pairView, setPairView] = useState<PairView | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [nextOverride, setNextOverride] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const pairRun = useRef<{ stopped: boolean } | null>(null);

  const [pull, setPull] = useState<{ code: string; deviceId: string; secret: string; expiresAt: number } | null>(null);
  const [pullBusy, setPullBusy] = useState(false);
  const [pullError, setPullError] = useState<"needServer" | "network" | "">("");
  const pullAttempts = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => () => {
    if (pairRun.current) pairRun.current.stopped = true;
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const goNext = () => navigate(nextOverride ?? next, { replace: true });

  const refreshPull = async () => {
    setPullBusy(true);
    setPullError("");
    try {
      const hasExplicit =
        !!getSavedServer() ||
        !!new URLSearchParams(window.location.search).get("server") ||
        !!import.meta.env.VITE_SERVER_URL ||
        !!getDefaultServer();
      if (app && !hasExplicit) {
        setPull(null);
        setPullError("needServer");
        return;
      }
      const r = await requestPullPairing(getServerBase());
      setPull(r);
      pullAttempts.current = 0;
    } catch {
      setPull(null);
      setPullError("network");
    } finally {
      setPullBusy(false);
    }
  };

  useEffect(() => {
    if (tab !== "device" || pairView) return;
    void refreshPull();
  }, [tab, pairView]);

  useEffect(() => {
    if (tab !== "device" || pairView || pull || pullError !== "network") return;
    if (pullAttempts.current >= 6) return;
    pullAttempts.current += 1;
    const id = window.setTimeout(() => void refreshPull(), 2500);
    return () => window.clearTimeout(id);
  }, [tab, pairView, pull, pullError]);

  useEffect(() => {
    if (tab !== "device" || !pull || pairView) return;
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
        void refreshPull();
        return;
      }
      timer = window.setTimeout(tick, Date.now() - startedAt < 30_000 ? 1500 : 5000);
    };
    timer = window.setTimeout(tick, 1500);
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [tab, pull, pairView]);

  useEffect(() => {
    if (pull && canvasRef.current) {
      renderQr(canvasRef.current, buildPairUrl(getServerBase(), pull.code)).catch(console.error);
    }
  }, [pull]);

  const runPairPoll = async (base: string, code: string, deviceId: string, secret: string, expiresAt: number) => {
    if (pairRun.current) pairRun.current.stopped = true;
    const run = { stopped: false };
    pairRun.current = run;
    const startedAt = Date.now();
    while (!run.stopped) {
      await sleep(Date.now() - startedAt < 30_000 ? 1500 : 5000);
      if (run.stopped) return;
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
    if (pairRun.current) pairRun.current.stopped = true;
    setPairView({ step: "claiming" });
    try {
      const r = await claimPairing(base, code);
      setPairView({ step: "waiting", accountName: r.accountName, expiresAt: r.expiresAt });
      void runPairPoll(base, code, r.deviceId, r.secret, r.expiresAt);
    } catch (e) {
      const errCode = (e as { code?: string }).code;
      setPairView({
        step: "error",
        kind: errCode === "E_PAIR_CLAIMED" ? "claimed" : errCode === "E_PAIR_EXPIRED" ? "invalid" : "network",
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

  /** 偏好面板里改了服务器地址:保存并刷新本机配对码。和内置默认相同时不落盘(以后默认变了能跟上)。 */
  const applyServer = (value: string) => {
    const v = value.trim();
    saveServer(app && v.replace(/\/+$/, "") === getDefaultServer() ? "" : v);
    setServer(v);
    if (tab === "device" && !pairView) void refreshPull();
  };

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
      if (err.code === "E_ACCOUNT_DELETED") setRecoveryError({ kind: "deleted", purgeAt: err.purgeAt });
      else if (err.code === "E_UNAUTHORIZED") setRecoveryError({ kind: "invalid" });
      // 服务器明确拒绝(设备数达上限):不能落到「无法连接服务器」,那会让人去查地址
      else if (err.code === "E_DEVICE_LIMIT") setRecoveryError({ kind: "deviceLimit" });
      else setRecoveryError({ kind: "network" });
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

  const fieldLabel = "mb-1.5 block text-13 font-medium text-ink-2";

  // ---------- 视图:push 配对流程 ----------
  if (pairView) {
    return (
      <CenterCard>
        {pairView.step === "claiming" && <p className="py-8 text-sm text-ink-3">…</p>}
        {pairView.step === "waiting" && (
          <>
            <h1 className="text-xl font-bold text-ink">{t("pairPage.waitingTitle")}</h1>
            <p className="text-sm text-ink-2">{t("pairPage.waitingFor", { name: pairView.accountName })}</p>
            <p className="font-display text-[44px] leading-none text-accent tabular-nums">
              {formatRemain(pairView.expiresAt, now)}
            </p>
            <div className="mx-auto size-8 animate-spin rounded-full border-4 border-accent-100 border-t-accent-600" />
          </>
        )}
        {pairView.step === "error" && (
          <>
            <Callout tone="danger">{pairErrorText(pairView.kind)}</Callout>
            <Button
              variant="primary"
              className="w-full"
              onClick={() => {
                if (pairRun.current) pairRun.current.stopped = true;
                setPairView(null);
              }}
            >
              {t("common.close")}
            </Button>
          </>
        )}
      </CenterCard>
    );
  }

  // ---------- 视图:恢复密钥一次性展示 ----------
  if (created) {
    return (
      <CenterCard wide>
        <h1 className="text-2xl font-bold tracking-[-0.02em] text-ink">{t("welcome.recoveryTitle")}</h1>
        <p className="text-sm text-ink-2">
          {t("welcome.recoveryNameLabel")}：<span className="font-semibold">{created.name}</span>
        </p>
        <Callout tone="warn">{t("welcome.recoveryWarn")}</Callout>
        <div className="ink-card flex items-center gap-3 rounded-14 px-4 py-3.5">
          <code className="min-w-0 flex-1 font-mono text-13 leading-relaxed break-all select-all">{created.recoveryKey}</code>
          <Button size="sm" onClick={() => void copyKey()} className="shrink-0 bg-white/12 text-white hover:bg-white/20">
            {copied ? t("welcome.copied") : t("welcome.copy")}
          </Button>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={savedAck} onChange={(e) => setSavedAck(e.target.checked)} className="checkbox mt-0.5" />
          {t("welcome.recoveryAck")}
        </label>
        <Button variant="primary" size="lg" onClick={goNext} disabled={!savedAck} className="w-full">
          {t("welcome.confirmBtn")}
        </Button>
      </CenterCard>
    );
  }

  // ---------- 视图:三入口表单 ----------
  const tabs: Array<{ value: Tab; label: string }> = [
    { value: "create", label: t("welcome.createTab") },
    { value: "device", label: t("welcome.deviceTab") },
    { value: "recovery", label: t("welcome.recoveryTab") },
  ];

  return (
    <div className="grid h-dvh box-border grid-cols-1 overflow-hidden bg-paper pt-[env(safe-area-inset-top)] md:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
      <BrandHero />
      <div className="flex min-h-0 items-start justify-center overflow-y-auto p-5 md:items-center md:p-10">
        <div className="flex w-full max-w-[392px] flex-col gap-4">
          {/* 移动紧凑品牌头:小屏不放 slogan;右侧不起眼的小齿轮收着服务器地址与语言 */}
          <div className="flex items-center gap-2 md:hidden">
            <LogoMark className="size-6 rounded-[6px]" />
            <span className="font-display text-lg font-medium tracking-[-0.02em] text-ink">Polyphony</span>
            <PrefsGear onClick={() => setPrefsOpen(true)} className="ml-auto" />
          </div>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold tracking-[-0.02em] text-ink">{t("welcome.title")}</h1>
              <p className="mt-1 hidden text-sm leading-relaxed text-ink-3 md:block">{t("welcome.subtitle")}</p>
            </div>
            <PrefsGear onClick={() => setPrefsOpen(true)} className="hidden md:grid" />
          </div>

          <Segmented
            size="md"
            className="w-full"
            value={tab}
            onChange={(v) => {
              setTab(v);
              setError("");
              setRecoveryError(null);
              pullAttempts.current = 0;
            }}
            options={tabs}
          />

          {tab === "create" && (
            <div className="flex flex-col gap-3">
              <div>
                <label htmlFor="accountName" className={fieldLabel}>{t("welcome.nameLabel")}</label>
                <input
                  id="accountName"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("welcome.namePlaceholder")}
                  maxLength={20}
                  className={inputClass()}
                />
              </div>
              <Button variant="primary" size="lg" onClick={() => void handleCreate()} disabled={busy || !name.trim()} className="w-full">
                {t("welcome.createBtn")}
              </Button>
            </div>
          )}

          {tab === "device" && (
            <div className="flex flex-col gap-3">
              <div className={cx("flex flex-col gap-3", app && "flex-col-reverse")}>
                <div className="flex flex-col items-center gap-2 text-center">
                  <p className="text-sm font-medium text-ink-2">{t("welcome.pullTitle")}</p>
                  {pull ? (
                    <>
                      <div className="rounded-14 bg-sheet p-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
                        <canvas ref={canvasRef} className="block size-[184px]" />
                      </div>
                      <p className="text-xs text-ink-3">{t("welcome.pullRemain", { time: formatRemain(pull.expiresAt, now) })}</p>
                    </>
                  ) : pullError === "needServer" ? (
                    <p className="px-2 text-sm leading-relaxed text-warn">{t("welcome.pullNeedServer")}</p>
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      {pullError === "network" && <p className="text-sm text-danger">{t("welcome.pullErr")}</p>}
                      <button onClick={() => void refreshPull()} disabled={pullBusy} className="text-sm text-accent-800 hover:underline disabled:opacity-50">
                        {pullBusy ? "…" : t("welcome.pullRefresh")}
                      </button>
                    </div>
                  )}
                  {!pullError && <p className="text-xs leading-relaxed text-ink-3">{t("welcome.pullHint")}</p>}
                </div>
                <Button variant="secondary" size="lg" icon="scan" onClick={() => setScanOpen(true)} className="w-full">
                  {t("welcome.scanLoginBtn")}
                </Button>
              </div>
              {scanNotice && <p className="text-xs break-words text-accent-800">{scanNotice}</p>}
            </div>
          )}

          {tab === "recovery" && (
            <div className="flex flex-col gap-3">
              <div>
                <label htmlFor="recoveryKey" className={fieldLabel}>{t("welcome.recoveryInputLabel")}</label>
                <input
                  id="recoveryKey"
                  type="text"
                  value={recoveryInput}
                  onChange={(e) => setRecoveryInput(e.target.value)}
                  placeholder="poly_r_…"
                  spellCheck={false}
                  autoComplete="off"
                  className={inputClass({ className: "font-mono text-13" })}
                />
              </div>
              <Button variant="primary" size="lg" onClick={() => void handleRecovery()} disabled={busy || !recoveryInput.trim()} className="w-full">
                {t("welcome.recoveryGoBtn")}
              </Button>
              {recoveryError?.kind === "invalid" && <Callout tone="danger">{t("welcome.errInvalidToken")}</Callout>}
              {recoveryError?.kind === "deviceLimit" && <Callout tone="danger">{t("welcome.errDeviceLimit")}</Callout>}
              {recoveryError?.kind === "network" && <Callout tone="danger">{t("welcome.errNetwork")}</Callout>}
              {recoveryError?.kind === "deleted" && (
                <Callout tone="warn" icon={null}>
                  <p>{t("welcome.accountDeleting")}</p>
                  <Button variant="secondary" size="sm" onClick={() => void handleRestoreDeleted()} disabled={busy} className="mt-2">
                    {t("welcome.accountRestoreBtn")}
                  </Button>
                </Callout>
              )}
            </div>
          )}

          {error && <Callout tone="danger">{error}</Callout>}

        </div>
      </div>

      {scanOpen && <ScanModal onResult={handleScanResult} onClose={() => setScanOpen(false)} />}
      {prefsOpen && (
        <PrefsDialog
          server={server}
          onSave={(v) => {
            applyServer(v);
            setPrefsOpen(false);
          }}
          onClose={() => setPrefsOpen(false)}
        />
      )}
    </div>
  );
}

/** 不起眼的小齿轮:服务器地址 / 界面语言收在这里(绝大多数人用默认即可)。 */
function PrefsGear({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("welcome.prefsTitle")}
      title={t("welcome.prefsTitle")}
      className={cx(
        "grid size-tap-38 shrink-0 cursor-pointer place-items-center rounded-full text-ink-4 transition-colors hover:bg-fill-2 hover:text-ink-2 active:bg-fill-2",
        className
      )}
    >
      <Icon name="settings" className="size-[18px]" />
    </button>
  );
}

function PrefsDialog({
  server,
  onSave,
  onClose,
}: {
  server: string;
  onSave: (server: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [pref, setPref] = useLocalePref();
  const [value, setValue] = useState(server);
  const label = "mb-1.5 block text-13 font-medium text-ink-2";
  return (
    <Dialog
      title={t("welcome.prefsTitle")}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={() => onSave(value)} className="w-full sm:w-auto">
          {t("settings.saveBtn")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor="server" className={label}>{t("welcome.serverLabel")}</label>
          <input
            id="server"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave(value);
            }}
            placeholder={getDefaultServer() || "https://docs.example.com"}
            spellCheck={false}
            autoComplete="off"
            className={inputClass({ className: "font-mono text-13" })}
          />
          <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{t("welcome.serverHint")}</p>
        </div>
        <div>
          <label htmlFor="welcomeLocale" className={label}>{t("settings.languageSection")}</label>
          <Select
            id="welcomeLocale"
            value={pref}
            onChange={(e) => setPref(e.target.value as LocalePref)}
            className="w-[180px]"
          >
            <option value="auto">{t("settings.languageAuto")}</option>
            <option value="zh">{t("settings.languageZh")}</option>
            <option value="en">{t("settings.languageEn")}</option>
          </Select>
        </div>
      </div>
    </Dialog>
  );
}

/** 居中卡片视图(配对流程 / 恢复密钥展示):移动整页浅纸底,桌面同样居中。 */
function CenterCard({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper p-4 pt-[calc(env(safe-area-inset-top)+16px)]">
      <div className={cx("flex w-full flex-col gap-4 rounded-20 bg-sheet p-7 shadow-md", wide ? "max-w-xl" : "max-w-sm")}>
        {children}
      </div>
    </div>
  );
}

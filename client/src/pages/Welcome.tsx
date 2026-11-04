// 首次引导:创建账号(Web 独占,token 一次性展示)、粘贴 token 或扫码配对登录。
// 无 token 的任何路由都会被重定向到这里(App.tsx 守卫),?next= 携带回跳目标。
// 扫码支持配对码(/pair,登录)与房间码(/join,登录后自动进房)两种载荷。
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getSavedServer, getServerBase, saveServer } from "@/lib/serverConfig";
import { createAccount, setToken, verifyLogin } from "@/lib/auth";
import { parseJoinPayload, parsePairPayload } from "@/lib/qr";
import { claimPairing, pollPairing, formatRemain } from "@/lib/pairing";
import { ScanModal } from "@/components/ScanModal";
import { isTauri } from "@/platform";
import { useT } from "@/i18n";

type View = "form" | "token-once";

// 扫码配对流程状态(null = 未在配对,显示常规表单)
type PairErrorKind = "claimed" | "invalid" | "denied" | "cancelled" | "network";
type PairView =
  | { step: "claiming" }
  | { step: "waiting"; accountName: string; expiresAt: number }
  | { step: "error"; kind: PairErrorKind };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Welcome() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useT();
  const next = searchParams.get("next") || "/";

  const app = isTauri();
  const [tab, setTab] = useState<"create" | "login">(app ? "login" : "create");
  const [server, setServer] = useState(getSavedServer());
  const [name, setName] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("form");
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // 扫码登录:配对流程视图 / 扫码弹层 / 房间码暂存回跳 / 提示条 / 秒级心跳
  const [pairView, setPairView] = useState<PairView | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [nextOverride, setNextOverride] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const pairStopped = useRef(false);

  useEffect(() => () => { pairStopped.current = true; }, []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 房间码扫码暂存的回跳优先于 URL ?next=(扫了房间码再登录 → 直接进房)
  const goNext = () => navigate(nextOverride ?? next, { replace: true });

  // ---------- 扫码配对登录(docs/pairing-login.md §4.4 接收端 A) ----------

  const runPairPoll = async (
    base: string,
    code: string,
    claimKey: string,
    expiresAt: number
  ) => {
    const startedAt = Date.now();
    // 前 30s 每 1.5s,后退避 5s:长 TTL 链接可能等几分钟才确认(D13)
    while (!pairStopped.current) {
      await sleep(Date.now() - startedAt < 30_000 ? 1500 : 5000);
      if (pairStopped.current) return;
      try {
        const r = await pollPairing(base, code, claimKey);
        if (r.status === "approved") {
          setToken(r.token);
          // /auth/me 校验(token 刚从服务端取得,失败多为网络抖动,不阻断)
          verifyLogin(base, r.token)
            .catch(() => undefined)
            .finally(goNext);
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
        setPairView({ step: "error", kind: "invalid" });
        return;
      }
    }
  };

  const startPair = async (base: string, code: string) => {
    setPairView({ step: "claiming" });
    try {
      const r = await claimPairing(base, code);
      setPairView({
        step: "waiting",
        accountName: r.accountName,
        expiresAt: r.expiresAt,
      });
      void runPairPoll(base, code, r.claimKey, r.expiresAt);
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
    // 分发顺序:先配对码(/pair),后房间码(/join/裸码)——pair 不可再落进 join
    const pair = parsePairPayload(text);
    if (pair) {
      if (pair.server) saveServer(pair.server);
      void startPair(pair.server ?? getServerBase(), pair.code);
      return;
    }
    const join = parseJoinPayload(text);
    if (join) {
      const params = new URLSearchParams({ code: join.code });
      if (join.server) params.set("server", join.server);
      setNextOverride(`/join?${params.toString()}`);
      setScanNotice(t("welcome.pairScannedRoom"));
      return;
    }
    setScanNotice(t("home.alertInvalidQr"));
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

  const handleCreate = async () => {
    setBusy(true);
    setError("");
    try {
      const acc = await createAccount(server, name.trim());
      setToken(acc.token);
      setCreated(acc);
      setView("token-once");
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ERR_NAME_TAKEN") setError(t("welcome.errNameTaken"));
      else if (code === "ERR_WEB_ONLY" || code === "E_NAME_INVALID")
        setError(code === "ERR_WEB_ONLY" ? t("welcome.errWebOnly") : t("welcome.errNameInvalid"));
      else setError(t("welcome.errNetwork"));
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async () => {
    setBusy(true);
    setError("");
    try {
      await verifyLogin(server, tokenInput.trim());
      setToken(tokenInput.trim());
      goNext();
    } catch {
      setError(t("welcome.errInvalidToken"));
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    if (!created) return;
    try {
      await navigator.clipboard?.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 非安全上下文降级:选中态已可手动复制 */
    }
  };

  // ---------- 扫码配对流程视图(覆盖常规表单) ----------
  if (pairView) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] box-border">
        <div className="max-w-xl w-full bg-white rounded-2xl shadow-2xl p-8 text-center space-y-4">
          {pairView.step === "claiming" && (
            <p className="text-gray-500 text-sm py-8">…</p>
          )}
          {pairView.step === "waiting" && (
            <>
              <h1 className="text-xl font-bold text-gray-900">
                {t("pairPage.waitingTitle")}
              </h1>
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

  // ---------- token 一次性展示页 ----------
  if (view === "token-once" && created) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] box-border">
        <div className="max-w-xl w-full bg-white rounded-2xl shadow-2xl p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">
            {t("welcome.tokenTitle")}
          </h1>
          <p className="text-sm text-gray-600 mb-6">
            {t("welcome.tokenNameLabel")}：<span className="font-semibold">{created.name}</span>
          </p>
          <div className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 mb-4 text-sm text-amber-800">
            ⚠️ {t("welcome.tokenWarn")}
          </div>
          <div className="rounded-xl bg-gray-900 px-4 py-4 mb-4 flex items-center gap-3">
            <code className="flex-1 text-green-300 font-mono text-sm break-all select-all">
              {created.token}
            </code>
            <button
              onClick={copyToken}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs font-medium hover:bg-white/20 transition-colors"
            >
              {copied ? t("welcome.copied") : t("welcome.copy")}
            </button>
          </div>
          <button
            onClick={goNext}
            className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg"
          >
            {t("welcome.confirmBtn")}
          </button>
        </div>
      </div>
    );
  }

  // ---------- 表单页 ----------
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] box-border">
      <div className="max-w-xl w-full">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            {t("welcome.title")}
          </h1>
          <p className="text-sm text-gray-600">{t("welcome.subtitle")}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl p-8 space-y-6">
          {/* Tab:创建仅 Web 显示(App 端只可粘贴 token) */}
          <div className="flex gap-2">
            {!app && (
              <button
                onClick={() => {
                  setTab("create");
                  setError("");
                }}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  tab === "create"
                    ? "bg-blue-50 border-blue-400 text-blue-700"
                    : "border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {t("welcome.createTab")}
              </button>
            )}
            <button
              onClick={() => {
                setTab("login");
                setError("");
              }}
              className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                tab === "login"
                  ? "bg-blue-50 border-blue-400 text-blue-700"
                  : "border-gray-300 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {t("welcome.loginTab")}
            </button>
          </div>

          <div>
            <label
              htmlFor="server"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
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

          {tab === "create" ? (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="accountName"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
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
              <p className="text-xs text-gray-500">{t("welcome.webOnlyNote")}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="tokenInput"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  {t("welcome.loginLabel")}
                </label>
                <input
                  id="tokenInput"
                  type="text"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={t("welcome.loginPlaceholder")}
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-sm"
                />
              </div>
              <button
                onClick={handleLogin}
                disabled={busy || !tokenInput.trim()}
                className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg disabled:opacity-50"
              >
                {t("welcome.loginBtn")}
              </button>
              <button
                type="button"
                onClick={() => setScanOpen(true)}
                className="w-full py-2.5 min-h-tap-44 rounded-lg border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50 transition-colors"
              >
                {t("welcome.scanLoginBtn")}
              </button>
              {scanNotice && (
                <p className="text-xs text-blue-600 break-words">{scanNotice}</p>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </div>

      {scanOpen && (
        <ScanModal onResult={handleScanResult} onClose={() => setScanOpen(false)} />
      )}
    </div>
  );
}

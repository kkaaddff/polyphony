// 首次引导:创建账号(Web 独占,token 一次性展示)或粘贴 token 登录。
// 无 token 的任何路由都会被重定向到这里(App.tsx 守卫),?next= 携带回跳目标。
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getSavedServer } from "@/lib/serverConfig";
import { createAccount, setToken, verifyLogin } from "@/lib/auth";
import { isTauri } from "@/platform";
import { useT } from "@/i18n";

type View = "form" | "token-once";

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

  const goNext = () => navigate(next, { replace: true });

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
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

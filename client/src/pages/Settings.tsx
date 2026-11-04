// 设置页(v4):语言 + 服务器直连 + 已登录设备 + 恢复密钥 + 注销账号。
// 保存后全端生效（WS 协同 / 附件上传均走此地址）；留空则 Web 回落同源。
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { getSavedServer, saveServer } from "@/lib/serverConfig";
import {
  fetchDevices,
  revokeDeviceById,
  regenerateRecoveryKey,
  deleteAccountRemote,
  clearAllLocalData,
  type DeviceInfo,
} from "@/lib/auth";
import { useAccount } from "@/lib/auth";
import { copyText } from "@/lib/clipboard";
import { useLocalePref, useT, type LocalePref } from "@/i18n";

type TestResult =
  | { ok: true; latency: number; docs: number; users: number }
  | { ok: false; message: string };

/** 补全协议头：裸 "1.2.3.4:8101" 视作 http。 */
function withScheme(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export default function Settings() {
  const navigate = useNavigate();
  const { t } = useT();
  const { account } = useAccount();
  const [url, setUrl] = useState(getSavedServer());
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [localePref, setLocalePref] = useLocalePref();

  // 已登录设备
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const reloadDevices = useCallback(() => {
    fetchDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);
  useEffect(reloadDevices, [reloadDevices]);

  const doRevoke = async (d: DeviceInfo) => {
    if (!window.confirm(t("settings.revokeConfirm", { label: d.label }))) return;
    try {
      await revokeDeviceById(d.id);
      if (d.current) {
        clearAllLocalData();
        navigate("/welcome", { replace: true });
        return;
      }
      reloadDevices();
    } catch {
      reloadDevices();
    }
  };

  // 恢复密钥重生成(旧的立即作废,新的只显示一次)
  const [newKey, setNewKey] = useState("");
  const [keyAck, setKeyAck] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const doRegenerate = async () => {
    if (!window.confirm(t("settings.regenConfirm"))) return;
    try {
      setNewKey(await regenerateRecoveryKey());
      setKeyAck(false);
    } catch {
      /* 忽略 */
    }
  };

  // 注销账号(危险区):输入账号名确认
  const [deleteName, setDeleteName] = useState("");
  const doDeleteAccount = async () => {
    if (!window.confirm(t("settings.deleteAccountConfirm"))) return;
    try {
      await deleteAccountRemote(deleteName.trim());
      clearAllLocalData();
      navigate("/welcome", { replace: true });
    } catch {
      alert(t("settings.deleteAccountFail"));
    }
  };

  const test = async () => {
    const base = withScheme(url);
    if (!base) {
      setResult({ ok: false, message: t("settings.needUrl") });
      return;
    }
    setUrl(base);
    setTesting(true);
    setResult(null);
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      const latency = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { docs?: number; totalUsers?: number };
      setResult({ ok: true, latency, docs: data.docs ?? 0, users: data.totalUsers ?? 0 });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : t("settings.connectFail") });
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    saveServer(withScheme(url));
    navigate("/");
  };

  const reset = () => {
    saveServer("");
    setUrl("");
    setResult(null);
  };

  const localeOptions: Array<{ value: LocalePref; label: string }> = [
    { value: "auto", label: t("settings.languageAuto") },
    { value: "zh", label: t("settings.languageZh") },
    { value: "en", label: t("settings.languageEn") },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 pt-[env(safe-area-inset-top)] box-border">
      <div className="max-w-xl w-full mx-auto pb-10">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">{t("settings.title")}</h1>
          <p className="text-gray-600">{t("settings.subtitle")}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl p-8 space-y-6">
          {/* 界面语言：默认跟随系统，三选一即时生效 */}
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-2">
              {t("settings.languageSection")}
            </span>
            <div className="flex gap-2" role="radiogroup" aria-label={t("settings.languageSection")}>
              {localeOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={localePref === opt.value}
                  onClick={() => setLocalePref(opt.value)}
                  className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium border transition-colors ${
                    localePref === opt.value
                      ? "bg-blue-50 border-blue-400 text-blue-700"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="serverUrl" className="block text-sm font-medium text-gray-700 mb-2">
              {t("settings.serverSection")}
            </label>
            <input
              type="text"
              id="serverUrl"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("settings.serverPlaceholder")}
              spellCheck={false}
              autoComplete="off"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-2">
              {t("settings.serverHint1")}
              <br />
              {t("settings.serverHint2")}
            </p>
          </div>

          {result && (
            <div
              className={`rounded-lg px-4 py-3 text-sm ${
                result.ok
                  ? "bg-green-50 text-green-700 border border-green-200"
                  : "bg-red-50 text-red-700 border border-red-200"
              }`}
            >
              {result.ok ? (
                <span>
                  {t("settings.testOk", {
                    ms: result.latency,
                    rooms: result.docs,
                    users: result.users,
                  })}
                </span>
              ) : (
                <span>{t("settings.testFail", { msg: result.message })}</span>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={test}
              disabled={testing}
              className="flex-1 py-3 px-6 min-h-tap-44 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {testing ? t("settings.testing") : t("settings.testBtn")}
            </button>
            <button
              onClick={save}
              className="flex-1 py-3 px-6 min-h-tap-44 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg"
            >
              {t("settings.saveBtn")}
            </button>
          </div>

          {getSavedServer() && (
            <button
              onClick={reset}
              className="w-full text-sm text-gray-500 hover:text-red-500 transition-colors"
            >
              {t("settings.clearSaved")}
            </button>
          )}
        </div>

        {/* 已登录设备(吊销即时断开;180 天未上线自动移除) */}
        <div className="bg-white rounded-2xl shadow-2xl p-8 space-y-4 mt-6">
          <span className="block text-sm font-medium text-gray-700">
            {t("settings.devicesSection")}
          </span>
          {devices.length === 0 ? (
            <p className="text-sm text-gray-500">…</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-gray-200 px-3 py-2"
                >
                  <span className="text-sm text-gray-900 font-medium">{d.label}</span>
                  {d.current && (
                    <span className="text-xs text-blue-600">{t("settings.currentDevice")}</span>
                  )}
                  <button
                    onClick={() => void doRevoke(d)}
                    className={`ml-auto px-3 py-1 rounded-lg text-xs font-medium border ${
                      d.current
                        ? "border-gray-300 text-gray-600 hover:bg-gray-50"
                        : "border-red-200 text-red-600 hover:bg-red-50"
                    }`}
                  >
                    {d.current ? t("topbar.logout") : t("settings.revokeBtn")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-gray-400">{t("settings.devicesNote")}</p>
        </div>

        {/* 恢复密钥 */}
        <div className="bg-white rounded-2xl shadow-2xl p-8 space-y-4 mt-6">
          <span className="block text-sm font-medium text-gray-700">
            {t("settings.recoverySection")}
          </span>
          {newKey ? (
            <div className="space-y-3">
              <div className="rounded-xl bg-gray-900 px-4 py-3 flex items-center gap-3">
                <code className="flex-1 text-green-300 font-mono text-sm break-all select-all">
                  {newKey}
                </code>
                <button
                  onClick={async () => {
                    if (await copyText(newKey)) {
                      setKeyCopied(true);
                      setTimeout(() => setKeyCopied(false), 1500);
                    }
                  }}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs font-medium hover:bg-white/20"
                >
                  {keyCopied ? t("welcome.copied") : t("welcome.copy")}
                </button>
              </div>
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={keyAck}
                  onChange={(e) => setKeyAck(e.target.checked)}
                  className="mt-0.5 size-4 accent-blue-600"
                />
                {t("welcome.recoveryAck")}
              </label>
              <button
                onClick={() => setNewKey("")}
                disabled={!keyAck}
                className="w-full py-2.5 rounded-lg bg-gray-900 text-white text-sm font-semibold hover:bg-gray-700 disabled:opacity-50"
              >
                {t("common.close")}
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500">{t("settings.recoveryNote")}</p>
              <button
                onClick={() => void doRegenerate()}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50"
              >
                {t("settings.regenBtn")}
              </button>
            </>
          )}
        </div>

        {/* 注销账号(危险区) */}
        <div className="bg-white rounded-2xl shadow-2xl p-8 space-y-4 mt-6 border border-red-100">
          <span className="block text-sm font-medium text-red-600">
            {t("settings.deleteAccountSection")}
          </span>
          <p className="text-xs text-gray-500 leading-relaxed">
            {t("settings.deleteAccountNote")}
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={deleteName}
              onChange={(e) => setDeleteName(e.target.value)}
              placeholder={account?.name ?? ""}
              maxLength={20}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 focus:border-transparent"
            />
            <button
              onClick={() => void doDeleteAccount()}
              disabled={!deleteName.trim() || deleteName.trim() !== account?.name}
              className="px-6 py-2.5 min-h-tap-44 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
            >
              {t("settings.deleteAccountBtn")}
            </button>
          </div>
        </div>

        <div className="text-center mt-6">
          <button
            onClick={() => navigate("/")}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            {t("settings.backHome")}
          </button>
        </div>
      </div>
    </div>
  );
}

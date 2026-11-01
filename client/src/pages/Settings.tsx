// 设置页：语言偏好 + 服务器直连地址配置（CS 架构核心入口）。
// 保存后全端生效（WS 协同 / 图片上传 / 在线房间均走此地址）；留空则 Web 回落同源。
import { useState } from "react";
import { useNavigate } from "react-router";
import { getSavedServer, saveServer } from "@/lib/serverConfig";
import { useLocalePref, useT, type LocalePref } from "@/i18n";

type TestResult =
  | { ok: true; latency: number; rooms: number; users: number }
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
  const [url, setUrl] = useState(getSavedServer());
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [localePref, setLocalePref] = useLocalePref();

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
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const latency = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        totalRooms?: number;
        totalUsers?: number;
      };
      setResult({
        ok: true,
        latency,
        rooms: data.totalRooms ?? 0,
        users: data.totalUsers ?? 0,
      });
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : t("settings.connectFail"),
      });
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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 pt-[env(safe-area-inset-top)] box-border">
      <div className="max-w-xl w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {t("settings.title")}
          </h1>
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
            <label
              htmlFor="serverUrl"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
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
                    rooms: result.rooms,
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

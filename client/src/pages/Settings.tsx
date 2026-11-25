// 设置(v5):桌面留在应用壳内,分区卡片 +「说明在左、控件在右」;移动为独立页(带返回)。
// 语言 + 服务器直连 + 已登录设备 + 恢复密钥 + 远程语音输入(桌面壳)+ 注销账号。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { getSavedServer, saveServer } from "@/lib/serverConfig";
import {
  fetchDevices,
  revokeDeviceById,
  regenerateRecoveryKey,
  deleteAccountRemote,
  clearAllLocalData,
  useAccount,
  type DeviceInfo,
} from "@/lib/auth";
import { copyText } from "@/lib/clipboard";
import { formatRelative } from "@/lib/roomCode";
import { useLocalePref, useT, type LocalePref } from "@/i18n";
import { isDesktopTauri } from "@/platform";
import { getAutostart, setAutostart } from "@/platform/autostart";
import { restartIme, setVoiceReceiveEnabled, useVoiceReceiver } from "@/lib/voiceReceiver";
import { useIsMobile } from "@/lib/useIsMobile";
import { Icon, type IconName } from "@/components/icons";
import { useToast } from "@/components/Toast";
import { Button, Callout, IconButton, Select, Switch, Tag, cx, inputClass } from "@/components/ui";

type TestResult =
  | { ok: true; latency: number; docs: number; users: number }
  | { ok: false; message: string };

/** 补全协议头:裸 "1.2.3.4:8101" 视作 http。 */
function withScheme(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export default function Settings() {
  const navigate = useNavigate();
  const { t, locale } = useT();
  const toast = useToast();
  const { account } = useAccount();
  const isMobile = useIsMobile();
  const [url, setUrl] = useState(getSavedServer());
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [localePref, setLocalePref] = useLocalePref();
  const voice = useVoiceReceiver();

  // 开机自启(仅桌面壳):以系统里真实的自启项为准
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [autostartErr, setAutostartErr] = useState("");
  useEffect(() => {
    if (!isDesktopTauri()) return;
    getAutostart().then(setAutostartState).catch((e) => setAutostartErr(String(e)));
  }, []);
  const toggleAutostart = (v: boolean) => {
    setAutostartErr("");
    setAutostart(v).then(setAutostartState).catch((e) => setAutostartErr(String(e)));
  };

  // 已登录设备
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const reloadDevices = useCallback(() => {
    fetchDevices().then(setDevices).catch(() => setDevices([]));
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
    // 移动是独立页:保存后回首页;桌面在壳内,原地给「已保存」反馈
    if (isMobile) navigate("/");
    else toast.show(t("settings.saved"), "success");
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
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[900px] px-4 py-6 md:px-8">
        {/* 页头 */}
        <div className="flex items-center gap-2">
          {isMobile && (
            <IconButton icon="left" size="touch" label={t("mobile.back")} onClick={() => navigate("/")} className="-ml-2" />
          )}
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-ink">{t("settings.title")}</h1>
        </div>
        <p className="mt-1 mb-2 text-sm text-ink-3">{t("settings.subtitle")}</p>

        {/* 通用:界面语言 */}
        <Section title={t("settings.secGeneral")}>
          <Card>
            <Row icon="globe" title={t("settings.languageSection")} desc={t("settings.languageAuto")}>
              <Select
                aria-label={t("settings.languageSection")}
                value={localePref}
                onChange={(e) => setLocalePref(e.target.value as LocalePref)}
                className="w-[160px]"
              >
                {localeOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </Select>
            </Row>
            {isDesktopTauri() && (
              <Row icon="monitor" title={t("settings.autostartTitle")} desc={autostartErr ? t("settings.autostartError", { msg: autostartErr }) : t("settings.autostartNote")}>
                <Switch
                  checked={autostart === true}
                  onChange={toggleAutostart}
                  label={t("settings.autostartTitle")}
                />
              </Row>
            )}
          </Card>
        </Section>

        {/* 连接:服务器地址 */}
        <Section title={t("settings.secConnection")}>
          <CardPad>
            <h3 className="text-sm font-semibold text-ink">{t("settings.serverSection")}</h3>
            <input
              type="text"
              id="serverUrl"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("settings.serverPlaceholder")}
              spellCheck={false}
              autoComplete="off"
              aria-label={t("settings.serverSection")}
              className={inputClass({ className: "font-mono text-13" })}
            />
            <p className="text-xs leading-relaxed text-ink-3">
              {t("settings.serverHint1")}
              <br />
              {t("settings.serverHint2")}
            </p>
            {result && (
              <Callout tone={result.ok ? "ok" : "danger"} icon={null}>
                {result.ok
                  ? t("settings.testOk", { ms: result.latency, rooms: result.docs, users: result.users })
                  : t("settings.testFail", { msg: result.message })}
              </Callout>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              {getSavedServer() && (
                <Button variant="ghost" onClick={reset} className="sm:mr-auto">{t("settings.clearSaved")}</Button>
              )}
              <Button variant="secondary" onClick={() => void test()} disabled={testing} className="max-sm:w-full">
                {testing ? t("settings.testing") : t("settings.testBtn")}
              </Button>
              <Button variant="primary" onClick={save} className="max-sm:w-full">{t("settings.saveBtn")}</Button>
            </div>
          </CardPad>
        </Section>

        {/* 账号:已登录设备 + 恢复密钥 */}
        <Section title={t("settings.secAccount", { name: account?.name ?? "" })}>
          <h3 className="mb-2 px-1 text-sm font-semibold text-ink">{t("settings.devicesSection")}</h3>
          <Card>
            {devices.length === 0 ? (
              <div className="px-[18px] py-4 text-sm text-ink-3">…</div>
            ) : (
              devices.map((d) => (
                <Row
                  key={d.id}
                  icon={/android|iphone|ipad|pixel|phone/i.test(d.label) ? "phone" : "laptop"}
                  title={d.label}
                  desc={
                    d.current
                      ? ""
                      : d.lastSeenAt
                        ? `${t("settings.lastSeen")} ${formatRelative(d.lastSeenAt, locale)}`
                        : ""
                  }
                >
                  {d.current && <Tag tone="accent">{t("settings.currentDevice")}</Tag>}
                  <Button
                    size="sm"
                    variant={d.current ? "secondary" : "dangerGhost"}
                    onClick={() => void doRevoke(d)}
                  >
                    {d.current ? t("topbar.logout") : t("settings.revokeBtn")}
                  </Button>
                </Row>
              ))
            )}
          </Card>
          <p className="mt-2 px-1 text-xs text-ink-3">{t("settings.devicesNote")}</p>

          <Card className="mt-3.5">
            <Row icon="key" title={t("settings.recoverySection")} desc={t("settings.recoveryNote")}>
              <Button variant="secondary" size="sm" onClick={() => void doRegenerate()}>{t("settings.regenBtn")}</Button>
            </Row>
            {newKey && (
              <div className="border-t border-line px-[18px] py-4">
                <div className="ink-card flex items-center gap-3 rounded-14 px-4 py-3.5">
                  <code className="min-w-0 flex-1 font-mono text-13 leading-relaxed break-all select-all">{newKey}</code>
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (await copyText(newKey)) {
                        setKeyCopied(true);
                        setTimeout(() => setKeyCopied(false), 1500);
                      }
                    }}
                    className="shrink-0 bg-white/12 text-white hover:bg-white/20"
                  >
                    {keyCopied ? t("welcome.copied") : t("welcome.copy")}
                  </Button>
                </div>
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={keyAck} onChange={(e) => setKeyAck(e.target.checked)} className="checkbox mt-0.5" />
                  {t("welcome.recoveryAck")}
                </label>
                <Button variant="primary" disabled={!keyAck} onClick={() => setNewKey("")} className="mt-3 w-full sm:w-auto">
                  {t("common.close")}
                </Button>
              </div>
            )}
          </Card>
        </Section>

        {/* 实验:远程语音输入(仅桌面壳) */}
        {isDesktopTauri() && (
          <Section title={t("settings.secExperimental")}>
            <CardPad>
              <div className="flex items-center gap-4">
                <span className="grid size-[38px] shrink-0 place-items-center rounded-10 bg-fill-1 text-ink-2">
                  <Icon name="wave" className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{t("settings.voiceSection")}</span>
                  <span className="mt-0.5 block text-xs leading-normal text-ink-3">{t("settings.voiceNote")}</span>
                </span>
                <Switch
                  checked={voice.enabled}
                  onChange={(v) => void setVoiceReceiveEnabled(v, true)}
                  label={t("settings.voiceEnable")}
                />
              </div>
              {voice.error && <Callout tone="danger">{t("settings.voiceError", { msg: voice.error })}</Callout>}
              {voice.enabled && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Tag tone={voice.connected ? "ok" : "warn"} icon={voice.connected ? "check" : undefined}>
                      {voice.connected ? t("settings.voiceServerOn") : t("settings.voiceServerOff")}
                    </Tag>
                    <Tag tone={voice.bridge?.imeClients ? "ok" : "neutral"} icon={voice.bridge?.imeClients ? "check" : undefined}>
                      {voice.bridge?.imeClients ? t("settings.voiceImeOn") : t("settings.voiceImeOff")}
                    </Tag>
                  </div>
                  {/* 插件没连上时说清楚卡在哪一步(插件随安装包附带,一般只差重启一次输入法) */}
                  {voice.bridge && !voice.bridge.imeClients && voice.bridge.imeSetup !== "unsupported" && (
                    <div className="flex flex-wrap items-center gap-2 text-xs leading-normal text-ink-3">
                      <span className="min-w-0 flex-1">{t(`settings.voiceIme_${voice.bridge.imeSetup}`)}</span>
                      {voice.bridge.imeSetup === "restart" && (
                        <Button variant="secondary" size="sm" onClick={() => void restartIme()}>
                          {t("settings.voiceRestartIme")}
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="rounded-10 bg-fill-1 px-3.5 py-3">
                    {voice.bridge?.active ? (
                      <>
                        <p className="flex items-center gap-1.5 text-xs text-accent-800">
                          {t("settings.voiceLive", { from: voice.fromLabel ?? "…" })}
                        </p>
                        <p className="mt-1 text-15 whitespace-pre-wrap break-words text-ink">{voice.bridge.text}</p>
                      </>
                    ) : voice.bridge?.lastCommitted ? (
                      <>
                        <p className="text-xs text-ink-3">{t("settings.voiceLast")}</p>
                        <p className="mt-1 text-15 whitespace-pre-wrap break-words text-ink">{voice.bridge.lastCommitted}</p>
                      </>
                    ) : (
                      <p className="text-xs text-ink-3">{t("settings.voiceEmpty")}</p>
                    )}
                  </div>
                  {voice.bridge?.socketPath && (
                    <p className="font-mono text-xs break-all text-ink-4">{t("settings.voiceSocket", { path: voice.bridge.socketPath })}</p>
                  )}
                </>
              )}
            </CardPad>
          </Section>
        )}

        {/* 危险区:注销账号 */}
        <Section title={t("settings.secDanger")}>
          <div className="rounded-14 bg-[#fffafa] shadow-[inset_0_0_0_1px_var(--color-danger-line)]">
            <div className="px-[18px] pt-4">
              <h3 className="text-sm font-semibold text-danger">{t("settings.deleteAccountSection")}</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-3">{t("settings.deleteAccountNote")}</p>
            </div>
            <div className="mt-3 flex flex-col gap-2 border-t border-danger-line px-[18px] py-4 sm:flex-row sm:items-center">
              <input
                type="text"
                value={deleteName}
                onChange={(e) => setDeleteName(e.target.value)}
                placeholder={t("settings.deleteNamePlaceholder", { name: account?.name ?? "" })}
                maxLength={20}
                aria-label={t("settings.deleteAccountSection")}
                className={inputClass({ className: "sm:max-w-[280px]" })}
              />
              <span className="hidden flex-1 sm:block" />
              <Button
                variant="danger"
                onClick={() => void doDeleteAccount()}
                disabled={!deleteName.trim() || deleteName.trim() !== account?.name}
                className="max-sm:w-full"
              >
                {t("settings.deleteAccountBtn")}
              </Button>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}

/* ---------- 分区布局:左列小标题,右列卡片(macOS 系统设置式) ---------- */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 grid grid-cols-1 items-start gap-x-6 gap-y-2 md:grid-cols-[148px_minmax(0,1fr)]">
      <h2 className="pt-1 text-sm font-semibold text-ink md:pt-[19px]">{title}</h2>
      <div className="flex min-w-0 flex-col">{children}</div>
    </section>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-14 bg-sheet shadow-sm", className)}>{children}</div>;
}

function CardPad({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-14 bg-sheet p-[18px] shadow-sm">{children}</div>;
}

function Row({
  icon,
  title,
  desc,
  children,
}: {
  icon: IconName;
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[60px] items-center gap-4 border-t border-line px-[18px] py-3 first:border-t-0">
      <span className="grid size-[38px] shrink-0 place-items-center rounded-10 bg-fill-1 text-ink-2">
        <Icon name={icon} className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-5 text-ink">{title}</span>
        {desc && <span className="mt-0.5 block text-xs leading-normal text-ink-3">{desc}</span>}
      </span>
      {children}
    </div>
  );
}

// 配对登录弹层(发起端):QR 出码(到期自动重生成)/邀请链接生成/活跃配对列表 + 确认。
// 轮询与红点归 Home(D13:有未清扫配对才轮询);本组件只消费 pairings + refresh。
import { useEffect, useRef, useState } from "react";
import { getServerBase } from "@/lib/serverConfig";
import { buildPairUrl, renderQr } from "@/lib/qr";
import {
  cancelPairing,
  confirmPairing,
  createPairing,
  formatRemain,
  shortenUa,
  type PairingInfo,
} from "@/lib/pairing";
import { useT } from "@/i18n";

const LINK_TIERS = [5, 15, 30, 60]; // 与服务端 LINK_TTL_MINUTES 对齐

interface PairModalProps {
  pairings: PairingInfo[];
  refresh: () => void;
  onClose: () => void;
}

function statusLabelKey(p: PairingInfo) {
  switch (p.status) {
    case "pending":
      return p.kind === "qr" ? "pair.stPending" : "pair.stPendingLink";
    case "claimed":
      return "pair.stClaimed";
    case "approved":
      return "pair.stApproved";
    case "consumed":
      return "pair.stConsumed";
    case "denied":
      return "pair.stDenied";
    case "cancelled":
      return "pair.stCancelled";
  }
}

export function PairModal({ pairings, refresh, onClose }: PairModalProps) {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const creatingQr = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const [tier, setTier] = useState(5);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  // 倒计时/到期检测的秒级心跳
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ESC 关闭(与 QrModal 一致)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // QR 自动生成/重生成:列表里没有 qr 配对(未生成或已被服务端清扫)即补一枚。
  // 服务端 sweep 在 status 里顺手清掉过期项,故「过期」在这里表现为消失。
  const qrItem = pairings.find((p) => p.kind === "qr");
  const latestLink = pairings.find((p) => p.kind === "link");
  useEffect(() => {
    if (qrItem || creatingQr.current) return;
    creatingQr.current = true;
    createPairing("qr")
      .then(refresh)
      .catch(console.error)
      .finally(() => {
        creatingQr.current = false;
      });
  }, [qrItem, refresh]);

  // 渲染二维码(扫码中显示被扫状态而非旧码)
  const showQr = qrItem?.status === "pending" && qrItem.expiresAt > now;
  useEffect(() => {
    if (!showQr || !qrItem) return;
    const canvas = canvasRef.current;
    if (canvas) renderQr(canvas, buildPairUrl(getServerBase(), qrItem.code)).catch(console.error);
  }, [showQr, qrItem]);

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 非安全上下文降级:输入框选中态可手动复制 */
    }
  };

  const generateLink = async () => {
    setLinkBusy(true);
    setActionError("");
    try {
      await createPairing("link", tier);
      refresh();
    } catch (e) {
      console.error(e);
      setActionError(t("pair.statusFail"));
    } finally {
      setLinkBusy(false);
    }
  };

  const runAction = async (code: string, fn: () => Promise<unknown>) => {
    setBusyCode(code);
    setActionError("");
    try {
      await fn();
      refresh();
    } catch (e) {
      console.error(e);
      setActionError(t("pair.statusFail"));
    } finally {
      setBusyCode(null);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-gray-900 mb-4">{t("pair.modalTitle")}</h3>

        {/* QR 区:待扫码显示码+倒计时;已扫码转提示(确认操作在下方列表) */}
        <section className="rounded-xl border border-gray-100 p-4 mb-4 text-center">
          <p className="text-xs text-gray-500 mb-2">{t("pair.qrSection")}</p>
          {showQr && qrItem ? (
            <>
              <div className="flex justify-center">
                <canvas ref={canvasRef} className="rounded-lg border border-gray-100" />
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {t("pair.remain", { time: formatRemain(qrItem.expiresAt, now) })}
              </p>
              <p className="text-[10px] text-gray-400 mt-1">{t("pair.qrDesc")}</p>
            </>
          ) : qrItem && (qrItem.status === "claimed" || qrItem.status === "approved") ? (
            <p className="text-sm text-blue-600 py-8">{t("pair.stClaimed")}</p>
          ) : (
            <p className="text-sm text-gray-400 py-8">…</p>
          )}
        </section>

        {/* 邀请链接区:档位 + 生成;生成后只读展示 URL(e2e 亦从 DOM 取) */}
        <section className="rounded-xl border border-gray-100 p-4 mb-4">
          <p className="text-xs text-gray-500 mb-2">{t("pair.linkSection")}</p>
          <div className="flex items-center gap-2 mb-2">
            <label htmlFor="pairTier" className="text-xs text-gray-600 shrink-0">
              {t("pair.linkTierLabel")}
            </label>
            <select
              id="pairTier"
              value={tier}
              onChange={(e) => setTier(Number(e.target.value))}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              {LINK_TIERS.map((m) => (
                <option key={m} value={m}>
                  {m} {t("pair.linkTierUnit")}
                </option>
              ))}
            </select>
            <button
              onClick={generateLink}
              disabled={linkBusy}
              className="ml-auto px-3 py-1.5 min-h-tap-40 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {t("pair.linkGenerate")}
            </button>
          </div>
          {latestLink && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={buildPairUrl(getServerBase(), latestLink.code)}
                onFocus={(e) => e.target.select()}
                aria-label={t("pair.linkCopy")}
                className="flex-1 min-w-0 px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-mono text-gray-600"
              />
              <button
                onClick={() => copyLink(buildPairUrl(getServerBase(), latestLink.code))}
                className="shrink-0 px-3 py-1.5 min-h-tap-40 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50 transition-colors"
              >
                {copied ? t("pair.copied") : t("pair.linkCopy")}
              </button>
            </div>
          )}
        </section>

        {/* 活跃配对列表:状态 + 剩余 + 操作(claimed 才是关键安全锚) */}
        {pairings.length > 0 && (
          <section>
            <p className="text-xs text-gray-500 mb-2">{t("pair.listTitle")}</p>
            <ul className="space-y-2">
              {pairings.map((p) => {
                const active =
                  p.status === "pending" || p.status === "claimed" || p.status === "approved";
                const busy = busyCode === p.code;
                return (
                  <li
                    key={p.code}
                    className="rounded-xl border border-gray-100 px-3 py-2 flex items-center gap-2 flex-wrap"
                  >
                    <span className="text-xs font-medium text-gray-500 shrink-0">
                      {p.kind === "qr" ? t("pair.kindQr") : t("pair.kindLink")}
                    </span>
                    <span
                      className={`text-sm font-medium ${
                        p.status === "consumed"
                          ? "text-green-600"
                          : p.status === "denied" || p.status === "cancelled"
                            ? "text-gray-400"
                            : p.status === "claimed"
                              ? "text-blue-600"
                              : "text-gray-700"
                      }`}
                    >
                      {t(statusLabelKey(p))}
                    </span>
                    {active && (
                      <span className="text-xs text-gray-400">
                        {t("pair.remain", { time: formatRemain(p.expiresAt, now) })}
                      </span>
                    )}
                    {p.claimedMeta && (
                      <span className="text-xs text-gray-400 truncate">
                        {t("pair.claimedFrom", { ua: shortenUa(p.claimedMeta.ua) })}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1.5">
                      {p.status === "claimed" && (
                        <>
                          <button
                            onClick={() =>
                              runAction(p.code, () => confirmPairing(p.code, true))
                            }
                            disabled={busy}
                            className="px-3 py-1.5 min-h-tap-40 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                          >
                            {t("pair.confirmBtn")}
                          </button>
                          <button
                            onClick={() =>
                              runAction(p.code, () => confirmPairing(p.code, false))
                            }
                            disabled={busy}
                            className="px-3 py-1.5 min-h-tap-40 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
                          >
                            {t("pair.denyBtn")}
                          </button>
                        </>
                      )}
                      {active && (
                        <button
                          onClick={() => runAction(p.code, () => cancelPairing(p.code))}
                          disabled={busy}
                          className="px-2 py-1.5 min-h-tap-40 text-xs text-gray-400 hover:text-red-500 disabled:opacity-50"
                        >
                          {t("pair.cancelBtn")}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {actionError && <p className="text-xs text-red-600 mt-2">{actionError}</p>}

        <button
          onClick={onClose}
          className="mt-4 w-full py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 transition-colors"
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

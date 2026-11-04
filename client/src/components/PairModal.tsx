// 「登录其他设备」弹窗(v2,docs/identity-and-sharing.md §4.6 发起端):
// push QR(2 分钟) + 链接(5/15/30/60 档) + 本账号未清扫配对列表(确认/拒绝/撤销)。
import { useEffect, useRef, useState } from "react";
import { buildPairUrl, renderQr } from "@/lib/qr";
import { copyText } from "@/lib/clipboard";
import {
  createPushPairing,
  approvePairing,
  cancelPairing,
  formatRemain,
  LINK_TTL_MINUTES,
  type PairingInfo,
} from "@/lib/pairing";
import { getServerBase } from "@/lib/serverConfig";
import { useT } from "@/i18n";

interface PairModalProps {
  pairings: PairingInfo[];
  refresh: () => void;
  onClose: () => void;
}

export function PairModal({ pairings, refresh, onClose }: PairModalProps) {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qr, setQr] = useState<{ code: string; expiresAt: number } | null>(null);
  const [linkTtl, setLinkTtl] = useState<number>(LINK_TTL_MINUTES[0]);
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(() => Date.now());

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

  // QR:无 qr 型配对时自动创建;过期自动重建(扫过的码留在列表里显示终态)。
  // 在途用 ref 防重入 —— 若把 busy 放进依赖,首轮 effect 的 cleanup 会把
  // 刚创建的结果作废,形成「创建→作废→再创建」风暴(挤爆每账号 3 个配对)。
  const activeQr = qr && now < qr.expiresAt ? qr : null;
  const creatingRef = useRef(false);
  useEffect(() => {
    if (activeQr || creatingRef.current) return;
    creatingRef.current = true;
    setBusy(true);
    createPushPairing("qr")
      .then((r) => setQr(r))
      .catch(() => {
        /* 失败下次渲染重试 */
      })
      .finally(() => {
        creatingRef.current = false;
        setBusy(false);
      });
  }, [activeQr]);

  useEffect(() => {
    if (activeQr && canvasRef.current) {
      renderQr(canvasRef.current, buildPairUrl(getServerBase(), activeQr.code)).catch(console.error);
    }
  }, [activeQr]);

  const makeLink = async () => {
    setBusy(true);
    try {
      const r = await createPushPairing("link", linkTtl);
      setLink({ url: buildPairUrl(getServerBase(), r.code), expiresAt: r.expiresAt });
      refresh();
    } catch {
      /* 忽略 */
    } finally {
      setBusy(false);
    }
  };

  const copy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopied(key);
      setTimeout(() => setCopied(""), 1500);
    }
  };

  const decide = async (code: string, accept: boolean) => {
    try {
      await approvePairing(code, accept);
      refresh();
    } catch {
      refresh();
    }
  };

  const cancel = async (code: string) => {
    try {
      await cancelPairing(code);
      refresh();
    } catch {
      refresh();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full max-h-[85vh] overflow-y-auto space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-gray-900">{t("pair.entry")}</h3>

        {/* 二维码(2 分钟,过期自动刷新) */}
        <section className="text-center space-y-2">
          <p className="text-sm font-medium text-gray-700">{t("pair.qrTitle")}</p>
          {activeQr ? (
            <>
              <div className="flex justify-center">
                <canvas ref={canvasRef} className="rounded-lg border border-gray-100" />
              </div>
              <p className="text-xs text-gray-400">
                {t("pair.qrRemain", { time: formatRemain(activeQr.expiresAt, now) })}
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-400 py-6">…</p>
          )}
        </section>

        {/* 邀请链接(分钟级档) */}
        <section className="space-y-2 border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-700">{t("pair.linkTitle")}</p>
          <div className="flex gap-2" role="radiogroup" aria-label={t("pair.linkTitle")}>
            {LINK_TTL_MINUTES.map((m) => (
              <button
                key={m}
                onClick={() => setLinkTtl(m)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  linkTtl === m
                    ? "bg-blue-50 border-blue-400 text-blue-700"
                    : "border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {t("pair.linkTtl", { n: m })}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void makeLink()}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
            >
              {t("pair.linkGen")}
            </button>
            {link && (
              <button
                onClick={() => void copy("link", link.url)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50"
              >
                {copied === "link" ? t("welcome.copied") : t("qrModal.copyLink")}
              </button>
            )}
          </div>
          {link && (
            <input
              type="text"
              readOnly
              value={link.url}
              aria-label={t("qrModal.copyLink")}
              onFocus={(e) => e.target.select()}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-xs text-gray-500 font-mono"
            />
          )}
        </section>

        {/* 未清扫配对列表:claimed 待确认(红点来源);approved 等上线;终态可复盘 */}
        {pairings.length > 0 && (
          <section className="space-y-2 border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700">{t("pair.listTitle")}</p>
            <ul className="space-y-2">
              {pairings.map((p) => (
                <li
                  key={p.code}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-gray-700 truncate">
                      {p.direction === "pull" ? t("pair.dirPull") : t("pair.kindQrOrLink", { kind: p.kind })}
                      {p.newcomerLabel ? ` · ${p.newcomerLabel}` : ""}
                    </span>
                    <span className="text-xs text-gray-400 shrink-0">
                      {now < p.expiresAt ? formatRemain(p.expiresAt, now) : t("pair.expired")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {p.status === "claimed" && (
                      <>
                        <span className="text-xs text-amber-600">{t("pair.waitingYou")}</span>
                        <button
                          onClick={() => void decide(p.code, true)}
                          className="px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                        >
                          {t("pair.approveBtn")}
                        </button>
                        <button
                          onClick={() => void decide(p.code, false)}
                          className="px-3 py-1 rounded-lg border border-gray-300 text-gray-600 text-xs font-medium hover:bg-gray-50"
                        >
                          {t("pair.denyBtn")}
                        </button>
                      </>
                    )}
                    {p.status === "pending" && p.direction === "push" && (
                      <span className="text-xs text-gray-500">{t("pair.waitingScan")}</span>
                    )}
                    {p.status === "approved" && (
                      <span className={`text-xs ${p.deviceOnline ? "text-green-600" : "text-gray-500"}`}>
                        {p.deviceOnline ? `✓ ${t("pair.deviceOnline")}` : t("pair.waitingOnline")}
                      </span>
                    )}
                    {(p.status === "pending" || p.status === "claimed" || p.status === "approved") &&
                      p.direction === "push" && (
                        <button
                          onClick={() => void cancel(p.code)}
                          className="px-3 py-1 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-50"
                        >
                          {t("pair.cancelBtn")}
                        </button>
                      )}
                    {(p.status === "denied" || p.status === "cancelled") && (
                      <span className="text-xs text-gray-400">
                        {p.status === "denied" ? t("pairPage.deniedTitle") : t("pairPage.cancelledTitle")}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <button
          onClick={onClose}
          className="w-full py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 transition-colors"
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

// 「登录新设备」弹窗(v4.0 联调反馈:一次只保留一个配对,不列历史):
// 一个配对码同时呈现二维码与链接。未扫码时没有任何状态条/按钮——
// 只有新设备真的扫了码,才在原地弹出「批准 / 拒绝」。
// 关闭弹窗会撤销未完成(未被批准)的码,重开即换新码,服务端不留孤儿记录。
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
import { useBackHandler } from "@/platform/backButton";

interface PairModalProps {
  pairings: PairingInfo[];
  refresh: () => void;
  onClose: () => void;
}

export function PairModal({ pairings, refresh, onClose }: PairModalProps) {
  // Android 返回键/侧滑返回:先关弹层
  useBackHandler(true, onClose);
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [linkTtl, setLinkTtl] = useState<number>(LINK_TTL_MINUTES[0]);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // 关闭时撤销未完成的码(已批准的不能撤销——服务端会连带吊销刚写入的设备)
  const liveRef = useRef<{ code: string; status: string } | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 卸载(关闭弹窗/返回键):未完成的码立即作废,下次打开换新码
  useEffect(
    () => () => {
      const s = liveRef.current;
      if (s && (s.status === "pending" || s.status === "claimed")) {
        void cancelPairing(s.code).catch(() => undefined);
      }
    },
    []
  );

  // ESC 关闭(与 QrModal 一致)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const expired = !!pairing && now >= pairing.expiresAt;
  const activePairing = pairing && !expired ? pairing : null;

  // 当前配对在服务端的状态(由 Home 每秒刷新的 pairings 带入);
  // 列表里没有它 = 刚创建还没刷到,按等待扫码处理。
  const mine = activePairing
    ? pairings.find((p) => p.code === activePairing.code)
    : undefined;
  const status = mine?.status ?? "pending";
  liveRef.current = activePairing ? { code: activePairing.code, status } : null;

  // 被拒/被撤销 = 本次结束:清掉当前码,effect 随即生成新的(始终只有一个在途码)
  useEffect(() => {
    if (status === "denied" || status === "cancelled") setPairing(null);
  }, [status]);

  // 只有一个在途码:没有/过期/被拒/已撤销 → 立即重建。
  // 在途用 ref 防重入 —— 若把 busy 放进依赖,首轮 effect 的 cleanup 会把
  // 刚创建的结果作废,形成「创建→作废→再创建」风暴(挤爆每账号 3 个配对)。
  const creatingRef = useRef(false);
  useEffect(() => {
    if (activePairing || creatingRef.current) return;
    creatingRef.current = true;
    createPushPairing(linkTtl)
      .then((r) => setPairing(r))
      .catch(() => {
        /* 失败下次渲染重试 */
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [activePairing, linkTtl]);

  useEffect(() => {
    if (activePairing && canvasRef.current) {
      renderQr(canvasRef.current, buildPairUrl(getServerBase(), activePairing.code)).catch(
        console.error
      );
    }
  }, [activePairing]);

  // 撤销当前码(服务端置 cancelled,新设备侧立刻显示已撤销),再重建一个
  const restart = () => {
    const old = pairing?.code;
    setPairing(null);
    setCopied(false);
    if (old) void cancelPairing(old).catch(() => undefined).finally(refresh);
    else refresh();
  };

  // 换 TTL 档 = 撤销当前码并按新时长重建
  const changeTtl = (m: number) => {
    setLinkTtl(m);
    restart();
  };

  const copy = async () => {
    if (!pairing) return;
    if (await copyText(buildPairUrl(getServerBase(), pairing.code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const decide = async (accept: boolean) => {
    if (!activePairing) return;
    try {
      await approvePairing(activePairing.code, accept);
    } catch {
      /* 过期等:刷新后由 status 驱动重建 */
    } finally {
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

        {/* 二维码 + 链接:同一个配对码的两种形态(TTL 档可换,换档即重建) */}
        <section className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="text-sm font-medium text-gray-700">{t("pair.qrTitle")}</p>
            <div className="flex gap-1" role="radiogroup" aria-label={t("pair.linkTitle")}>
              {LINK_TTL_MINUTES.map((m) => (
                <button
                  key={m}
                  onClick={() => changeTtl(m)}
                  className={`px-2 py-1 rounded-md text-xs border whitespace-nowrap transition-colors ${
                    linkTtl === m
                      ? "bg-blue-50 border-blue-400 text-blue-700"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {t("pair.linkTtl", { n: m })}
                </button>
              ))}
            </div>
          </div>
          {activePairing ? (
            <>
              <div className="flex justify-center">
                <canvas ref={canvasRef} className="rounded-lg border border-gray-100" />
              </div>
              <p className="text-xs text-gray-400 text-center">
                {t("pair.qrRemain", { time: formatRemain(activePairing.expiresAt, now) })}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => void copy()}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50"
                >
                  {copied ? t("welcome.copied") : t("pair.linkTitle")}
                </button>
              </div>
              {copied && (
                <input
                  type="text"
                  readOnly
                  value={buildPairUrl(getServerBase(), activePairing.code)}
                  aria-label={t("pair.linkTitle")}
                  onFocus={(e) => e.target.select()}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-xs text-gray-500 font-mono"
                />
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400 py-6 text-center">…</p>
          )}
        </section>

        {/* 只有新设备扫了码才出现授权入口;未扫码时不显示任何状态条 */}
        {activePairing && status === "claimed" && (
          <section className="border-t border-gray-100 pt-4 space-y-2">
            <p className="text-sm text-amber-600">
              {t("pair.waitingYou")}
              {mine?.newcomerLabel ? ` · ${mine.newcomerLabel}` : ""}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => void decide(true)}
                className="flex-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                {t("pair.approveBtn")}
              </button>
              <button
                onClick={() => void decide(false)}
                className="flex-1 px-3 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm font-medium hover:bg-gray-50"
              >
                {t("pair.denyBtn")}
              </button>
            </div>
          </section>
        )}
        {activePairing && status === "approved" && (
          <p className={`text-sm text-center ${mine?.deviceOnline ? "text-green-600" : "text-gray-500"}`}>
            {mine?.deviceOnline ? `✓ ${t("pair.deviceOnline")}` : t("pair.waitingOnline")}
          </p>
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
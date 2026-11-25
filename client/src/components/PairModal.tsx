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
  PAIR_RESULT_LINGER_MS,
  type PairingInfo,
} from "@/lib/pairing";
import { getServerBase } from "@/lib/serverConfig";
import { useT } from "@/i18n";
import { Button, Callout, Dialog, cx, inputClass } from "./ui";

interface PairModalProps {
  pairings: PairingInfo[];
  refresh: () => void;
  onClose: () => void;
}

export function PairModal({ pairings, refresh, onClose }: PairModalProps) {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
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

  const expired = !!pairing && now >= pairing.expiresAt;
  const activePairing = pairing && !expired ? pairing : null;

  // 当前配对在服务端的状态(由应用壳每秒刷新的 pairings 带入);
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

  // 批准之后这个码已经用掉:提示停留片刻就关弹窗(不等新设备上线,也不再留着一个失效的二维码)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (status !== "approved") return;
    const id = window.setTimeout(() => onCloseRef.current(), PAIR_RESULT_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  // 只有一个在途码:没有/过期/被拒/已撤销 → 立即重建。
  // 在途用 ref 防重入 —— 若把 busy 放进依赖,首轮 effect 的 cleanup 会把
  // 刚创建的结果作废,形成「创建→作废→再创建」风暴(挤爆每账号 3 个配对)。
  const creatingRef = useRef(false);
  useEffect(() => {
    if (activePairing || creatingRef.current) return;
    creatingRef.current = true;
    createPushPairing()
      .then((r) => setPairing(r))
      .catch(() => {
        /* 失败下次渲染重试 */
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [activePairing]);

  useEffect(() => {
    if (activePairing && canvasRef.current) {
      renderQr(canvasRef.current, buildPairUrl(getServerBase(), activePairing.code)).catch(
        console.error
      );
    }
  }, [activePairing]);

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
    <Dialog onClose={onClose} title={t("pair.entry")} desc={t("pair.qrDesc")} className="md:max-w-[520px]">
      {/* 二维码 + 链接:同一个配对码的两种形态(有效期固定 5 分钟,过期自动换新) */}
      <div className="flex flex-col items-center gap-4 md:flex-row md:items-start md:gap-5">
        <div className="relative shrink-0 rounded-14 bg-sheet p-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <canvas ref={canvasRef} className="block size-60" />
          {(!activePairing || status === "approved") && (
            <span className="absolute inset-2 grid place-items-center bg-sheet text-xs text-ink-3">
              {status === "approved" && activePairing ? "✓" : "…"}
            </span>
          )}
        </div>
        <div className="flex w-full min-w-0 flex-1 flex-col items-center gap-3 md:items-start">
          <div className="text-center md:text-left">
            <p className="flex items-baseline justify-center gap-2 md:justify-start">
              <span className="text-13 text-ink-3">{t("pair.remain")}</span>
              <span className="font-display text-[44px] leading-none font-normal tracking-[-0.02em] text-accent tabular-nums">
                {activePairing ? formatRemain(activePairing.expiresAt, now) : "–:––"}
              </span>
            </p>
            <p className="mt-1.5 text-xs text-ink-3">{t("pair.qrHint")}</p>
          </div>
          <Button variant="secondary" size="sm" icon="link" onClick={() => void copy()}>
            {copied ? t("welcome.copied") : t("pair.linkTitle")}
          </Button>
        </div>
      </div>
      {copied && (
        <input
          type="text"
          readOnly
          value={pairing ? buildPairUrl(getServerBase(), pairing.code) : ""}
          aria-label={t("pair.linkTitle")}
          onFocus={(e) => e.target.select()}
          className={cx(inputClass(), "mt-3 font-mono text-xs")}
        />
      )}

      {/* 只有新设备扫了码才出现授权入口;未扫码时不显示任何状态条 */}
      {activePairing && status === "claimed" && (
        <>
          <div className="mt-4 h-px shrink-0 bg-line" />
          <Callout tone="warn" className="mt-4">
            <span className="font-semibold">{t("pair.waitingYou")}</span>
            {mine?.newcomerLabel ? ` · ${mine.newcomerLabel}` : ""}
          </Callout>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => void decide(false)}>
              {t("pair.denyBtn")}
            </Button>
            <Button variant="primary" className="flex-1" onClick={() => void decide(true)}>
              {t("pair.approveBtn")}
            </Button>
          </div>
        </>
      )}
      {activePairing && status === "approved" && (
        <Callout tone="ok" icon={null} className="mt-4 shrink-0">
          {mine?.deviceOnline ? `✓ ${t("pair.deviceOnline")}` : `✓ ${t("pair.waitingOnline")}`}
        </Callout>
      )}
    </Dialog>
  );
}

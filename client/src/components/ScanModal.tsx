// 扫码弹层(V10「扫码或粘贴链接」):
// Android App 走原生插件全屏扫码;其余环境 jsQR + getUserMedia rAF 解码。
// 所有形态都提供粘贴链接输入(桌面无摄像头时为主入口);结果统一交调用方 intake 分派。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  decodeVideoFrame,
  getCameraStream,
  hasNativeScanner,
  nativeCancelScan,
  nativeScanQr,
  rejectionMessage,
  stopStream,
} from "@/platform/scanQr";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";
import { Button, cx, inputClass } from "./ui";

interface ScanModalProps {
  onResult: (text: string) => void;
  onClose: () => void;
}

export function ScanModal({ onResult, onClose }: ScanModalProps) {
  // Android 返回键/侧滑返回:先关弹层
  useBackHandler(true, onClose);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { t } = useT();
  const [error, setError] = useState("");
  const [waitingNative] = useState(hasNativeScanner());
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState("");
  // 原生扫码结果晚到(用户已切到粘贴)时丢弃
  const abandoned = useRef(false);

  // ESC 关闭（与二维码弹层一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 回调走 ref:调用方传的是内联箭头,且欢迎页每秒重渲染(倒计时)——若进 effect 依赖,
  // 扫码会每秒被拆掉重开,插件每次 dismantle+setup 相机 → 画面与黑屏交替闪烁(v4 实踩)。
  const onResultRef = useRef(onResult);
  const onCloseRef = useRef(onClose);
  onResultRef.current = onResult;
  onCloseRef.current = onClose;

  // 原生分支:只在挂载时启动一次;卸载(取消/返回键/切粘贴)时取消插件扫码释放相机
  const [nativeLive, setNativeLive] = useState(false);
  useEffect(() => {
    if (!waitingNative) return;
    let cancelled = false;
    (async () => {
      try {
        setNativeLive(true);
        const text = await nativeScanQr();
        if (cancelled || abandoned.current) return;
        if (text) onResultRef.current(text);
        else onCloseRef.current();
      } catch (e) {
        if (cancelled || abandoned.current) return;
        // 失败不再停留在空黑屏(实踩「调起扫码失败:[object Object]」孤零零挂中间):
        // 立即切粘贴为主入口,错误作为顶部条带展示。
        const raw = rejectionMessage(e);
        if (raw === "cancelled") return;
        setError(
          raw === "ERR_SCAN_PERMISSION"
            ? t("scanModal.permDenied")
            : t("scanModal.nativeFail", { msg: raw })
        );
        setPasteMode(true);
      } finally {
        if (!cancelled) setNativeLive(false);
      }
    })();
    return () => {
      cancelled = true;
      void nativeCancelScan();
    };
    // 依赖刻意不含 t:语言切换不该重启原生扫码(相机会黑一下)。
  }, [waitingNative]);

  // 原生取景进行中:页面整体透明,露出 WebView 下层的相机预览(windowed 模式)
  useEffect(() => {
    if (!nativeLive || pasteMode) return;
    document.documentElement.classList.add("native-scanning");
    return () => document.documentElement.classList.remove("native-scanning");
  }, [nativeLive, pasteMode]);

  const leaveNative = (toPaste: boolean) => {
    abandoned.current = true;
    void nativeCancelScan();
    setNativeLive(false);
    if (toPaste) setPasteMode(true);
    else onClose();
  };

  // 网页分支：video 取景 + rAF 循环解码
  useEffect(() => {
    if (waitingNative || pasteMode) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;

    (async () => {
      try {
        stream = await getCameraStream();
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const canvas = document.createElement("canvas");
        const tick = () => {
          if (cancelled) return;
          const text = decodeVideoFrame(video, canvas);
          if (text) {
            onResultRef.current(text);
            return;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        // ERR_NO_CAMERA:环境无 getUserMedia(http:// 直连等)→ 切粘贴为主入口(无错误条);
        // 其余(权限拒绝等)透传浏览器消息,同样落到粘贴视图顶部条带。
        const msg = e instanceof Error ? e.message : "";
        if (msg === "ERR_NO_CAMERA") setPasteMode(true);
        else {
          setError(msg || t("scanModal.cameraFallback"));
          setPasteMode(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stopStream(stream);
    };
  }, [waitingNative, pasteMode, t]);

  const submitPaste = (e: React.FormEvent) => {
    e.preventDefault();
    const text = pasted.trim();
    if (text) onResult(text);
  };

  const pasteBox = (
    <form onSubmit={submitPaste} className="flex w-full max-w-sm flex-col gap-2.5">
      <label htmlFor="pasteLink" className="text-13 font-medium text-white/85">
        {t("scanModal.pasteLabel")}
      </label>
      <input
        id="pasteLink"
        type="text"
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder={t("scanModal.pastePlaceholder")}
        spellCheck={false}
        autoComplete="off"
        className={inputClass()}
      />
      <Button type="submit" variant="primary" size="lg" disabled={!pasted.trim()} className="w-full">
        {t("scanModal.pasteGo")}
      </Button>
    </form>
  );

  const ghost = "min-h-tap-40 cursor-pointer rounded-10 px-4 text-sm font-medium text-white/70 transition-colors duration-100 ease-swift hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white/60";
  const transparent = waitingNative && !pasteMode;
  return createPortal(
    <div
      data-floating
      className={cx(
        "fixed inset-0 z-50 flex flex-col items-center justify-center p-4",
        transparent ? "bg-transparent" : "bg-[rgb(12_13_20)]"
      )}
    >
      {pasteMode ? (
        <div className="flex w-full flex-col items-center gap-3">
          {error && (
            <p className="max-w-sm text-center text-sm leading-relaxed text-[#fda4af] break-words">
              {error}
            </p>
          )}
          {pasteBox}
          <button type="button" onClick={onClose} className={ghost}>
            {t("common.close")}
          </button>
        </div>
      ) : waitingNative ? (
        // 透明取景层:相机预览在 WebView 下方,这里只画取景框与退出入口
        <div className="flex h-full w-full flex-col items-center justify-between py-10">
          <p className="text-sm text-white drop-shadow-md">{t("scanModal.aim")}</p>
          <div className="size-60 rounded-[28px] shadow-[0_0_0_9999px_rgb(12_13_20/0.45),inset_0_0_0_1px_rgb(255_255_255/0.8)]" />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => leaveNative(true)}
              className={cx(ghost, "bg-white/10")}
            >
              {t("scanModal.pasteInstead")}
            </button>
            <button
              type="button"
              onClick={() => leaveNative(false)}
              className="min-h-tap-44 cursor-pointer rounded-xl bg-white px-6 text-sm font-semibold text-ink transition-colors hover:bg-sheet-tint focus-visible:outline-2 focus-visible:outline-white/60"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-white drop-shadow-md">{t("scanModal.aim")}</p>
          <div className="aspect-square w-full max-w-[260px] overflow-hidden rounded-20 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.25)]">
            <video ref={videoRef} playsInline muted className="size-full object-cover" />
          </div>
          <div className="mt-5 w-full max-w-sm">{pasteBox}</div>
          <button type="button" onClick={onClose} className={cx(ghost, "mt-3")}>
            {t("common.cancel")}
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

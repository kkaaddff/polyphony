// 扫码弹层(V10「扫码或粘贴链接」):
// Android App 走原生插件全屏扫码;其余环境 jsQR + getUserMedia rAF 解码。
// 所有形态都提供粘贴链接输入(桌面无摄像头时为主入口);结果统一交调用方 intake 分派。
import { useEffect, useRef, useState } from "react";
import {
  decodeVideoFrame,
  getCameraStream,
  hasNativeScanner,
  nativeScanQr,
  stopStream,
} from "@/platform/scanQr";
import { useT } from "@/i18n";

interface ScanModalProps {
  onResult: (text: string) => void;
  onClose: () => void;
}

export function ScanModal({ onResult, onClose }: ScanModalProps) {
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

  // 原生分支：插件自带全屏取景，这里只等结果（取消返回 null）
  useEffect(() => {
    if (!waitingNative) return;
    let cancelled = false;
    (async () => {
      try {
        const text = await nativeScanQr();
        if (cancelled || abandoned.current) return;
        if (text) onResult(text);
        else onClose();
      } catch (e) {
        // 原生扫码失败不再静默关闭(用户只会觉得「按钮没反应」),显式报错。
        if (!cancelled && !abandoned.current)
          setError(
            t("scanModal.nativeFail", {
              msg: e instanceof Error ? e.message : String(e),
            })
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [waitingNative, onResult, onClose, t]);

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
            onResult(text);
            return;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        // ERR_NO_CAMERA:环境无 getUserMedia(http:// 直连等),走本地化文案;
        // 其余(权限拒绝等)透传浏览器消息。无摄像头 → 直接切粘贴为主入口。
        const msg = e instanceof Error ? e.message : "";
        if (msg === "ERR_NO_CAMERA") setPasteMode(true);
        else setError(msg || t("scanModal.cameraFallback"));
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stopStream(stream);
    };
  }, [waitingNative, pasteMode, onResult, t]);

  const submitPaste = (e: React.FormEvent) => {
    e.preventDefault();
    const text = pasted.trim();
    if (text) onResult(text);
  };

  const pasteBox = (
    <form onSubmit={submitPaste} className="w-full max-w-sm space-y-3">
      <label htmlFor="pasteLink" className="block text-sm font-medium text-white">
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
        className="w-full px-4 py-3 rounded-lg text-sm text-gray-900 border border-gray-300 focus:ring-2 focus:ring-blue-400 outline-none"
      />
      <button
        type="submit"
        disabled={!pasted.trim()}
        className="w-full py-2.5 min-h-tap-44 rounded-lg bg-white text-gray-900 text-sm font-semibold disabled:opacity-50"
      >
        {t("scanModal.pasteGo")}
      </button>
    </form>
  );

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col items-center justify-center p-4">
      {error ? (
        <div className="text-center space-y-4 w-full flex flex-col items-center">
          <p className="text-red-400 text-sm">{error}</p>
          {pasteBox}
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-lg bg-white text-gray-900 text-sm font-medium"
          >
            {t("scanModal.gotIt")}
          </button>
        </div>
      ) : pasteMode ? (
        <div className="w-full flex flex-col items-center gap-4">
          {pasteBox}
          <button
            onClick={onClose}
            className="px-8 py-2 rounded-lg bg-white/10 text-white text-sm font-medium hover:bg-white/20 transition-colors"
          >
            {t("common.close")}
          </button>
        </div>
      ) : waitingNative ? (
        <div className="text-center space-y-4">
          <p className="text-white text-sm">{t("scanModal.nativeStarting")}</p>
          <button
            onClick={() => {
              abandoned.current = true;
              setPasteMode(true);
            }}
            className="px-6 py-2 rounded-lg bg-white/10 text-white text-sm font-medium hover:bg-white/20 transition-colors"
          >
            {t("scanModal.pasteInstead")}
          </button>
          <button
            onClick={onClose}
            className="px-8 py-2 rounded-lg bg-white/10 text-white text-sm font-medium hover:bg-white/20 transition-colors"
          >
            {t("common.cancel")}
          </button>
        </div>
      ) : (
        <>
          <p className="text-white text-sm mb-4">{t("scanModal.aim")}</p>
          <div className="w-full max-w-sm aspect-square rounded-2xl overflow-hidden border-2 border-white/30">
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full h-full object-cover"
            />
          </div>
          <div className="mt-4 w-full max-w-sm">
            {pasteBox}
          </div>
          <button
            onClick={onClose}
            className="mt-4 px-8 py-2 rounded-lg bg-white/10 text-white text-sm font-medium hover:bg-white/20 transition-colors"
          >
            {t("common.cancel")}
          </button>
        </>
      )}
    </div>
  );
}

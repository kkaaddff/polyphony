// 二维码弹层：房间码 → Web join URL，canvas 渲染；点遮罩/ESC/按钮关闭。
import { useEffect, useRef } from "react";
import { buildJoinUrl, renderQr } from "@/lib/qr";
import { useT } from "@/i18n";

interface QrModalProps {
  code: string;
  server: string;
  onClose: () => void;
}

export function QrModal({ code, server, onClose }: QrModalProps) {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) renderQr(canvas, buildJoinUrl(server, code)).catch(console.error);
  }, [code, server]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-xs w-full text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-gray-900 mb-1">{t("qrModal.title")}</h3>
        <p className="text-xs text-gray-500 mb-4">
          {t("qrModal.desc", { code })}{" "}
        </p>
        <div className="flex justify-center">
          <canvas
            ref={canvasRef}
            className="rounded-lg border border-gray-100"
          />
        </div>
        <p className="text-[10px] text-gray-500 mt-4 break-all leading-relaxed">
          {buildJoinUrl(server, code)}
        </p>
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

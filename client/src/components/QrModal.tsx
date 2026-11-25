// 二维码弹层:任意 URL(canvas 渲染)+ 复制链接,点遮罩/ESC/关闭按钮关闭。
// 房间邀请(join URL)/「分享本站」/配对码共用;文案由调用方传入。
import { useEffect, useRef, useState } from "react";
import { renderQr } from "@/lib/qr";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/i18n";
import { Button, Dialog } from "./ui";

interface QrModalProps {
  url: string;
  title: string;
  desc?: string;
  onClose: () => void;
}

export function QrModal({ url, title, desc, onClose }: QrModalProps) {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) renderQr(canvas, url).catch(console.error);
  }, [url]);

  const doCopy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Dialog
      onClose={onClose}
      title={title}
      desc={desc}
      className="md:max-w-[340px]"
      footer={
        <Button variant="primary" icon="link" onClick={() => void doCopy()} className="flex-1">
          {copied ? t("welcome.copied") : t("qrModal.copyLink")}
        </Button>
      }
    >
      <div className="flex justify-center">
        {/* 画布固有 240px:按原尺寸显示,模块边缘最锐、最好扫 */}
        <div className="rounded-14 bg-sheet p-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
          <canvas ref={canvasRef} className="block size-60" />
        </div>
      </div>
      <p className="mt-3.5 text-center font-mono text-xs leading-relaxed text-ink-3 break-all">{url}</p>
    </Dialog>
  );
}

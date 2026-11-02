// 扫码能力封装：Web/桌面 = jsQR + getUserMedia；Android App = plugin-barcode-scanner（P5 接入）。
// 注意：getUserMedia 仅安全上下文可用（https/localhost/App WebView）——
// 直连 http://IP 的手机浏览器扫不了码属预期，该场景由系统相机扫码打开 Web 版兜底。
import jsQR from "jsqr";
import { isTauri } from "./index";

/** Android App：原生扫码插件可用时优先走插件（P5 装插件后生效）。 */
export function hasNativeScanner(): boolean {
  return isTauri() && /android/i.test(navigator.userAgent);
}

/** 原生全屏扫码（插件，仅移动端编入）；取消返回 null，识别返回内容字符串。 */
export async function nativeScanQr(): Promise<string | null> {
  const { scan, Format } = await import(
    "@tauri-apps/plugin-barcode-scanner"
  );
  const result = await scan({ formats: [Format.QRCode], windowed: false });
  return result?.content ?? null;
}

export async function getCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // 稳定错误码,由 ScanModal 映射为本地化文案(scanModal.noCamera)
    throw new Error("ERR_NO_CAMERA");
  }
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false,
  });
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** 单帧解码：从 video 抓帧（降采样到 ~480px 宽）交给 jsQR；未识别返回 null。 */
export function decodeVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement
): string | null {
  if (video.readyState !== video.HAVE_ENOUGH_DATA || !video.videoWidth) {
    return null;
  }
  const w = 480;
  const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const code = jsQR(image.data, w, h, { inversionAttempts: "dontInvert" });
  return code?.data ?? null;
}

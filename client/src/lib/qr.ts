// 二维码载荷：统一编成 Web URL，任何手机系统相机都能扫码进 Web 版兜底，
// App 内扫码则经 lib/intake.ts 统一解析出 code+server 走直连。
// 形如：<server>/join?code=<房间码>&server=<直连地址>
//      <server>/pair?code=<配对码>&server=<直连地址>（配对登录，docs/identity-and-sharing.md）
import QRCode from "qrcode";

export function buildJoinUrl(serverBase: string, code: string): string {
  const u = new URL("/join", serverBase);
  u.searchParams.set("code", code.toUpperCase());
  u.searchParams.set("server", serverBase);
  return u.toString();
}

/** 配对登录载荷:与 join 同构,路径为 /pair(QR 与邀请链接是同一 URL 的两种形态)。 */
export function buildPairUrl(serverBase: string, code: string): string {
  const u = new URL("/pair", serverBase);
  u.searchParams.set("code", code);
  u.searchParams.set("server", serverBase);
  return u.toString();
}

/** 渲染到 canvas（240px，M 级纠错——内网 URL 约 100 字符足够）。 */
export function renderQr(canvas: HTMLCanvasElement, text: string): Promise<void> {
  return QRCode.toCanvas(canvas, text, {
    width: 240,
    margin: 2,
    errorCorrectionLevel: "M",
  });
}

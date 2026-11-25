// 上传前图片重编码(L24,docs/document-lifecycle.md §4.8):
// 去全部元数据(含 GPS;重编码天然丢弃 EXIF)、EXIF 方向自动摆正、长边 ≤2560px。
// 三端通用零依赖(<img> 解码 + canvas + toBlob)。GIF 原样上传(保动画);
// 处理失败不上传原图(避免元数据泄露)。
const MAX_EDGE = 2560;
const MAX_BYTES = 5 * 1024 * 1024;

export type PrepResult =
  | { ok: true; blob: Blob; filename: string }
  | { ok: false; error: "decode" | "encode" | "gif-too-large" };

function loadBitmap(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode"))),
      type,
      quality
    );
  });
}

/** PNG 若超 5MB 降级 WebP 0.9;其余原格式重编码 0.85。 */
async function encode(canvas: HTMLCanvasElement, isPng: boolean): Promise<Blob> {
  if (isPng) {
    const png = await canvasToBlob(canvas, "image/png");
    if (png.size <= MAX_BYTES) return png;
    const webp = await canvasToBlob(canvas, "image/webp", 0.9);
    if (webp.size <= MAX_BYTES) return webp;
    return png; // 仍超限则交服务端按 E_FILE_SIZE 拒绝并提示
  }
  return canvasToBlob(canvas, "image/webp", 0.85);
}

export async function prepImageForUpload(file: File): Promise<PrepResult> {
  const name = file.name || "image";
  // GIF:重新编码会杀掉动画 → 原样上传,仍受 5MB 限制
  if (file.type === "image/gif" || /\.gif$/i.test(name)) {
    return file.size > MAX_BYTES
      ? { ok: false, error: "gif-too-large" }
      : { ok: true, blob: file, filename: name };
  }

  try {
    // 浏览器解码自动按 EXIF 方向摆正,重编码后方向即固化、元数据即丢弃
    const img = await loadBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, error: "encode" };
    ctx.drawImage(img, 0, 0, w, h);

    const isPng = file.type === "image/png" || /\.png$/i.test(name);
    const blob = await encode(canvas, isPng);
    const ext = blob.type === "image/png" ? "png" : "webp";
    const stem = name.replace(/\.[^.]+$/, "") || "image";
    return { ok: true, blob, filename: `${stem}.${ext}` };
  } catch {
    return { ok: false, error: "decode" };
  }
}

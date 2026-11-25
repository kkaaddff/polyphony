// 房间码与相对时间纯函数（首页/列表共用小工具）。

const ROOM_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROOM_CODE_LENGTH = 8;

/** 生成 8 位随机房间码（大写字母 + 数字）。 */
export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS.charAt(
      Math.floor(Math.random() * ROOM_CODE_CHARS.length)
    );
  }
  return code;
}

/** 相对时间格式化（locale 感知，走标准 Intl.RelativeTimeFormat）。 */
export function formatRelative(ts: number, locale: string): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (min < 1) return rtf.format(0, "minute");
  if (min < 60) return rtf.format(-min, "minute");
  const hr = Math.floor(min / 60);
  if (hr < 24) return rtf.format(-hr, "hour");
  return rtf.format(-Math.floor(hr / 24), "day");
}

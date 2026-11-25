// 线性图标(v5):一套 24 网格、1.75 描边、圆头端点的内联 SVG,替换此前 emoji /
// Ant Design / 自绘三套混用。描边跟随 currentColor;默认 16px,由调用方用 className 改尺寸。
import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "plus" | "search" | "scan" | "qr" | "link" | "share" | "more" | "moreH" | "close"
  | "down" | "right" | "left" | "check" | "checkSq" | "trash" | "restore" | "pin" | "mic" | "wave"
  | "file" | "filePlus" | "folder" | "users" | "user" | "userPlus" | "laptop" | "monitor" | "phone"
  | "settings" | "logout" | "download" | "upload" | "undo" | "redo" | "image" | "table" | "minus"
  | "bold" | "italic" | "underline" | "strike" | "code" | "list" | "listOl" | "listCheck" | "heading"
  | "quote" | "refresh" | "copy" | "key" | "globe" | "server" | "alert" | "info" | "pen" | "keyboard";

const P: Record<IconName, ReactNode> = {
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  scan: <><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></>,
  qr: <><rect width="5" height="5" x="3" y="3" rx="1" /><rect width="5" height="5" x="16" y="3" rx="1" /><rect width="5" height="5" x="3" y="16" rx="1" /><path d="M21 16h-3a2 2 0 0 0-2 2v3" /><path d="M12 7v3a2 2 0 0 1-2 2H7" /><path d="M16 12h1" /><path d="M12 21v-1" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  share: <><path d="M12 15V3" /><path d="m8 7 4-4 4 4" /><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></>,
  more: <><circle cx="12" cy="5" r="1.1" /><circle cx="12" cy="12" r="1.1" /><circle cx="12" cy="19" r="1.1" /></>,
  moreH: <><circle cx="5" cy="12" r="1.1" /><circle cx="12" cy="12" r="1.1" /><circle cx="19" cy="12" r="1.1" /></>,
  close: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  down: <path d="m6 9 6 6 6-6" />,
  right: <path d="m9 18 6-6-6-6" />,
  left: <path d="m15 18-6-6 6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  checkSq: <><path d="m9 11 3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
  trash: <><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></>,
  restore: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>,
  pin: <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />,
  mic: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></>,
  wave: <><path d="M2 10v4" /><path d="M6 6v12" /><path d="M10 3v18" /><path d="M14 8v8" /><path d="M18 5v14" /><path d="M22 10v4" /></>,
  file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>,
  filePlus: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M12 12v6" /><path d="M9 15h6" /></>,
  folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  user: <><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  userPlus: <><path d="M2 21a8 8 0 0 1 13.29-6" /><circle cx="10" cy="8" r="5" /><path d="M19 16v6" /><path d="M22 19h-6" /></>,
  laptop: <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />,
  monitor: <><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></>,
  phone: <><rect width="14" height="20" x="5" y="2" rx="2.5" /><path d="M12 18h.01" /></>,
  settings: <><path d="M21 4h-7" /><path d="M10 4H3" /><path d="M21 12h-9" /><path d="M8 12H3" /><path d="M21 20h-5" /><path d="M12 20H3" /><circle cx="12" cy="4" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="15" cy="20" r="2" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  image: <><rect width="18" height="18" x="3" y="3" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" /></>,
  table: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M12 3v18" /><path d="M3 9h18" /><path d="M3 15h18" /></>,
  minus: <path d="M5 12h14" />,
  bold: <path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8" />,
  italic: <><path d="M19 4h-9" /><path d="M14 20H5" /><path d="M15 4 9 20" /></>,
  underline: <><path d="M6 4v6a6 6 0 0 0 12 0V4" /><path d="M4 20h16" /></>,
  strike: <><path d="M16 4H9a3 3 0 0 0-2.83 4" /><path d="M14 12a4 4 0 0 1 0 8H6" /><path d="M4 12h16" /></>,
  code: <><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></>,
  list: <><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>,
  listOl: <><path d="M10 6h11" /><path d="M10 12h11" /><path d="M10 18h11" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /></>,
  listCheck: <><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></>,
  heading: <><path d="M6 12h12" /><path d="M6 20V4" /><path d="M18 20V4" /></>,
  quote: <><path d="M17 6H3" /><path d="M21 12H8" /><path d="M21 18H8" /><path d="M3 12v6" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
  copy: <><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
  key: <><path d="M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".6" /></>,
  globe: <><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></>,
  server: <><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" /><path d="M6 6h.01" /><path d="M6 18h.01" /></>,
  alert: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  pen: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
  keyboard: <><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" /></>,
};

type IconProps = Omit<SVGProps<SVGSVGElement>, "name" | "children"> & { name: IconName };

export function Icon({ name, className = "size-4", ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {P[name]}
    </svg>
  );
}

export function ChevronDownIcon({ className = "size-4" }: { className?: string }) {
  return <Icon name="down" className={className} />;
}
export function CloseIcon({ className = "size-4" }: { className?: string }) {
  return <Icon name="close" className={className} />;
}
export function UndoIcon({ className = "size-5" }: { className?: string }) {
  return <Icon name="undo" className={className} />;
}
export function RedoIcon({ className = "size-5" }: { className?: string }) {
  return <Icon name="redo" className={className} />;
}

/**
 * 品牌标「三声部辫」:与 client/src-tauri/icons/source/icon-default.svg 同一份路径——
 * 靛蓝渐变 squircle 上三条正弦带(白 / 天蓝 / 白)靠深色 halo 描边做上下穿插。
 */
export function LogoMark({ className = "size-6" }: { className?: string }) {
  const d1 = "M -80 512 C 48 254 176 254 304 512 C 432 770 560 770 688 512 C 816 254 944 254 1090 512";
  const d2 = "M -80 770 C 48 770 176 512 304 512 C 432 512 560 254 688 254 C 816 254 944 512 1090 512";
  const d3 = "M -80 254 C 48 254 176 512 304 512 C 432 512 560 770 688 770 C 816 770 944 512 1090 512";
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id="polyphony-mark-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#1e1b4b" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="228" fill="url(#polyphony-mark-gradient)" />
      <g fill="none" strokeLinecap="round">
        <path d={d1} stroke="#1e1b4b" strokeOpacity="0.85" strokeWidth="150" />
        <path d={d1} stroke="#f8fafc" strokeWidth="98" />
        <path d={d2} stroke="#1e1b4b" strokeOpacity="0.85" strokeWidth="150" />
        <path d={d2} stroke="#7dd3fc" strokeWidth="98" />
        <path d={d3} stroke="#1e1b4b" strokeOpacity="0.85" strokeWidth="150" />
        <path d={d3} stroke="#f8fafc" strokeWidth="98" />
      </g>
    </svg>
  );
}

/** 声部律动:三根小竖条,表示「有人正在这里写」(样式见 index.css .voice-glyph)。 */
export function VoiceGlyph({ className = "h-3" }: { className?: string }) {
  return (
    <span className={`voice-glyph ${className}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

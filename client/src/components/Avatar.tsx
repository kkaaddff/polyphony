// 用户头像:用户名首字母(保留大小写,Array.from 防代理对)+ 身份哈希底色。
// aria-hidden:无障碍名字由旁边的用户名文本承载,头像纯装饰。
import { getUserColor } from "@/lib/userColors";

interface AvatarProps {
  name?: string | null;
  id?: string;
  className?: string;
}

export function Avatar({ name, id, className = "size-9 text-base" }: AvatarProps) {
  const initial = Array.from((name ?? "").trim() || "?")[0];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-full text-white font-semibold select-none shrink-0 ${className}`}
      style={{ backgroundColor: id ? getUserColor(id) : "#9CA3AF" }}
    >
      {initial}
    </span>
  );
}

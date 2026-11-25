// 用户头像:用户名首字母(保留大小写,Array.from 防代理对)+ 声部色底(与协同光标同色)。
// 首字母经 ::before 的 attr() 画出,不进 DOM 文本:头像纯装饰(aria-hidden),
// 旁边的用户名才是它的无障碍名字——复制一行、页内查找、按文本定位都不会多出一个首字母。
import { getUserColor } from "@/lib/userColors";
import { cx } from "./ui";

interface AvatarProps {
  name?: string | null;
  id?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE = {
  sm: "size-[22px] text-[10px]",
  md: "size-7 text-xs",
  lg: "size-9 text-sm",
} as const;

export function Avatar({ name, id, size = "md", className }: AvatarProps) {
  const initial = Array.from((name ?? "").trim() || "?")[0];
  return (
    <span
      aria-hidden="true"
      data-initial={initial}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)] select-none before:content-[attr(data-initial)]",
        SIZE[size],
        className
      )}
      style={{ backgroundColor: id ? getUserColor(id) : "var(--color-ink-4)" }}
    />
  );
}

/** 头像堆叠(文档头的在场提示):最多显示 max 个,彼此重叠 6px,白描边分隔。 */
export function AvatarStack({
  users,
  max = 3,
  className,
}: {
  users: Array<{ id?: string; name?: string | null }>;
  max?: number;
  className?: string;
}) {
  const shown = users.slice(0, max);
  return (
    <span aria-hidden="true" className={cx("inline-flex shrink-0 items-center", className)}>
      {shown.map((u, i) => (
        <Avatar
          key={u.id ?? i}
          id={u.id}
          name={u.name}
          size="sm"
          className={cx("-ml-1.5 shadow-[0_0_0_2px_var(--color-sheet),inset_0_0_0_1px_rgb(255_255_255/0.14)]", i === 0 && "ml-0")}
        />
      ))}
    </span>
  );
}

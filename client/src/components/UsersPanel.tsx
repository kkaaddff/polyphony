// 在线用户列表(awareness presence):头像 + 用户名 + 客户端标签;本机置顶并标注。
// variant=popover:文档头「在场」浮层里的紧凑列表;panel:完整编辑器右侧常驻栏。
import type { User } from "@/types";
import { useT } from "@/i18n";
import { Avatar } from "./Avatar";
import { VoiceGlyph } from "./icons";
import { Tag, cx } from "./ui";

export function UsersPanel({
  users,
  variant = "popover",
  className,
}: {
  users: User[];
  variant?: "popover" | "panel";
  className?: string;
}) {
  const { t } = useT();
  const panel = variant === "panel";
  return (
    <div className={cx("w-full", className)}>
      <p
        className={cx(
          "font-semibold text-ink-4",
          panel ? "px-1 pt-1 text-xs tracking-[0.04em]" : "px-2 pt-1 pb-1.5 text-[11px] tracking-[0.04em]"
        )}
      >
        {t("usersPanel.online", { n: users.length })}
      </p>
      <ul className={cx("space-y-0.5", panel && "mt-2")}>
        {users.map((user) => (
          <li
            key={user.clientId ?? user.id}
            data-testid="online-user"
            className={cx(
              "flex items-center gap-2.5 rounded-10 px-2 transition-colors duration-100 ease-swift hover:bg-fill-1",
              panel ? "h-12" : "h-[46px]"
            )}
          >
            <Avatar id={user.id} name={user.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium text-ink">{user.name}</p>
                {user.isSelf && <Tag tone="accent">{t("usersPanel.thisDevice")}</Tag>}
              </div>
              {user.client && <p className="mt-px truncate text-xs text-ink-3">{user.client}</p>}
            </div>
            {/* 声部律动:本机(正在此编辑) */}
            {user.isSelf && <VoiceGlyph className="h-3 shrink-0 text-ok" />}
          </li>
        ))}
      </ul>
    </div>
  );
}

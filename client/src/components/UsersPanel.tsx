// 在线用户面板：awareness presence 列表(色点 + 用户名 + 客户端标签;本机置顶并标注)。
// sidebar=桌面编辑页右侧常驻栏(md:w-80);其余(弹层/抽屉)铺满容器宽度。
import type { User } from "@/types";
import { useT } from "@/i18n";

export function UsersPanel({ users, sidebar = false }: { users: User[]; sidebar?: boolean }) {
  const { t } = useT();
  return (
    <div
      className={`w-full bg-white dark:bg-gray-800 p-6 overflow-y-auto ${
        sidebar ? "md:w-80 md:border-l border-gray-200 dark:border-gray-700" : ""
      }`}
    >
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
        {t("usersPanel.online", { n: users.length })}
      </h2>

      <ul className="space-y-3">
        {users.map((user) => (
          <li
            key={user.clientId ?? user.id}
            data-testid="online-user"
            className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50"
          >
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: user.color || "#999" }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <p className="font-medium text-gray-900 dark:text-white truncate">{user.name}</p>
                {user.isSelf && (
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none bg-blue-100 text-blue-700">
                    {t("usersPanel.thisDevice")}
                  </span>
                )}
              </div>
              {user.client && (
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{user.client}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

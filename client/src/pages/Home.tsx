import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { upsertRecentRoom } from "@/lib/storage";
import { generateRoomCode, formatRelative } from "@/lib/roomCode";
import { getServerBase, saveServer } from "@/lib/serverConfig";
import { parseJoinPayload, buildJoinUrl } from "@/lib/qr";
import { authFetch, clearToken, useAccount } from "@/lib/auth";
import { useT } from "@/i18n";
import { QrModal } from "@/components/QrModal";
import { ScanModal } from "@/components/ScanModal";
import { Menu, MenuItem } from "@/components/Menu";
import { Avatar } from "@/components/Avatar";
import { ScanIcon } from "@/components/icons";
import { isDesktopTauri } from "@/platform";
import { onTrayAction, pushRecentRooms } from "@/platform/tray";

type OnlineRoom = { code: string; userCount: number };
type MyRoom = { code: string; name: string; lastUsed: number; userCount: number };

export default function Home() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, locale } = useT();
  const { account } = useAccount();
  const serverBase = useMemo(() => getServerBase(), []);

  // ?join=CODE:扫码落地(未登录设备登录后转来)预填房间码
  // slice(0,8) 与输入框 maxLength 对齐:?join= 传入超长码时两端必须进同一房间
  const [roomCode, setRoomCode] = useState(
    () => (searchParams.get("join") ?? "").toUpperCase().slice(0, 8)
  );
  const [myRooms, setMyRooms] = useState<MyRoom[]>([]);
  const [onlineRooms, setOnlineRooms] = useState<OnlineRoom[]>([]);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [shareSite, setShareSite] = useState(false);
  // 右栏:我的房间 / 在线房间;批量管理模式(仅我的房间)
  const [tab, setTab] = useState<"mine" | "online">("mine");
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 我的房间(服务端房间簿,跨端一致)
  const fetchMine = useCallback(async () => {
    try {
      const res = await authFetch(`${getServerBase()}/rooms`);
      const data = await res.json();
      setMyRooms(Array.isArray(data?.rooms) ? data.rooms : []);
    } catch {
      /* 401 已由 authFetch 统一处理;网络失败静默 */
    }
  }, []);

  // 在线房间(公开 /health,兼作服务器连通探测)
  const fetchOnline = useCallback(async () => {
    try {
      const res = await fetch(`${getServerBase()}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raw = (
        Array.isArray(data?.rooms) ? data.rooms : []
      ) as Array<Record<string, unknown>>;
      setOnlineRooms(
        raw
          .map((r) => ({
            code: String(r?.code ?? ""),
            userCount: Number(r?.userCount ?? 0),
          }))
          .filter((r) => r.code)
      );
      setServerOk(true);
    } catch {
      setServerOk(false);
    }
  }, []);

  useEffect(() => {
    fetchMine();
    fetchOnline();
    const id = window.setInterval(() => {
      fetchMine();
      fetchOnline();
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        fetchMine();
        fetchOnline();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchMine, fetchOnline]);

  // 统一进入房间:服务端登记 + 跳转(名字来自账号)
  const enterRoom = useCallback(
    (code: string) => {
      const existing = myRooms.find((r) => r.code === code)?.name ?? "";
      authFetch(`${getServerBase()}/rooms/enter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name: existing }),
      })
        .then((r) => r.json())
        .then((d) => Array.isArray(d?.rooms) && setMyRooms(d.rooms))
        .catch(() => {
          /* 登记失败不阻断进房 */
        });
      upsertRecentRoom({ code, name: existing });
      navigate(
        `/editor?code=${code}&name=${encodeURIComponent(account?.name ?? "")}`
      );
    },
    [myRooms, account, navigate]
  );

  const handleCreateNew = () => enterRoom(generateRoomCode());

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (!code) {
      alert(t("home.alertNeedRoomCode"));
      document.getElementById("roomCode")?.focus();
      return;
    }
    enterRoom(code);
  };

  // 扫码结果 → 固化 server(载荷携带时)→ 进房
  const handleScanResult = (text: string) => {
    setScanOpen(false);
    const payload = parseJoinPayload(text);
    if (!payload) {
      alert(t("home.alertInvalidQr"));
      return;
    }
    if (payload.server) saveServer(payload.server);
    setRoomCode(payload.code);
    enterRoom(payload.code);
  };

  // 退出房间(单个/批量):服务端解除关联,房间内容不受影响
  const doLeave = async (codes: string[]) => {
    try {
      const res = await authFetch(`${getServerBase()}/rooms/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes }),
      });
      const data = await res.json();
      if (Array.isArray(data?.rooms)) setMyRooms(data.rooms);
      setSelected(new Set());
    } catch {
      /* 401 统一处理 */
    }
  };

  const leaveSingle = (code: string) => {
    if (!window.confirm(t("home.leaveSingleConfirm", { code }))) return;
    void doLeave([code]);
  };

  const toggleSelect = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const leaveSelected = () => {
    if (selected.size === 0) return;
    if (!window.confirm(t("home.leaveBatchConfirm", { n: selected.size }))) return;
    void doLeave([...selected]);
  };

  const logout = () => {
    if (!window.confirm(t("topbar.logoutConfirm"))) return;
    clearToken();
    navigate("/welcome", { replace: true });
  };

  // 桌面:我的房间 → 托盘菜单;语言变化重建
  useEffect(() => {
    if (!isDesktopTauri()) return;
    pushRecentRooms(
      myRooms.map(({ code, name, lastUsed }) => ({ code, name, lastUsed })),
      locale
    );
  }, [myRooms, locale]);

  // 桌面:托盘动作(新建/直达房间)→ 导航
  const enterRef = useRef(enterRoom);
  enterRef.current = enterRoom;
  useEffect(() => {
    if (!isDesktopTauri()) return;
    let disposed = false;
    let un: (() => void) | undefined;
    onTrayAction((action) => {
      if (action.type === "new") enterRef.current(generateRoomCode());
      else enterRef.current(action.code);
    }).then((u) => (disposed ? u() : (un = u)));
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const nameByCode = new Map(myRooms.map((r) => [r.code, r.name]));
  const allSelected = myRooms.length > 0 && selected.size === myRooms.length;

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-blue-50 to-indigo-100 overflow-hidden pt-[env(safe-area-inset-top)] box-border">
      {/* 顶栏:品牌居左;右上角用户名 + 头像菜单(设置/分享本站/退出登录)。
          服务器地址不再常驻展示 —— 配置只走设置页;不可达仍有黄色细条引导。 */}
      <header className="flex items-center justify-between px-6 py-3 shrink-0">
        {/* 品牌左上角:桌面显示;移动端隐藏(小屏留给内容,品牌在 welcome 页呈现) */}
        <div className="hidden md:flex items-baseline gap-3 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">
            {t("common.appName")}
          </h1>
          <p className="text-sm text-gray-500 truncate hidden md:block">
            {t("common.taglineShort")}
          </p>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-gray-700 font-medium truncate max-w-[10rem]">
            {account?.name ?? t("common.anonymous")}
          </span>
          <Menu
            buttonTitle={t("home.accountMenuTitle")}
            buttonClassName="flex items-center justify-center rounded-full p-1 min-w-tap-40 min-h-tap-40 hover:bg-white/70 transition-colors"
            buttonContent={
              <Avatar
                name={account?.name ?? t("common.anonymous")}
                id={account?.id}
              />
            }
          >
            <MenuItem onClick={() => navigate("/settings")}>
              {t("home.settingsLink")}
            </MenuItem>
            <MenuItem onClick={() => setShareSite(true)}>
              {t("home.shareSite")}
            </MenuItem>
            <MenuItem onClick={logout} className="text-red-600">
              {t("topbar.logout")}
            </MenuItem>
          </Menu>
        </div>
      </header>

      {/* 服务器不可达细条引导 */}
      {serverOk === false && (
        <div className="mx-6 mb-2 rounded-lg bg-yellow-50 border border-yellow-200 px-4 py-2 text-sm text-yellow-800 shrink-0">
          {t("home.serverUnreachableBefore")}
          <Link
            to="/settings"
            className="font-semibold underline underline-offset-2"
          >
            {t("home.serverUnreachableLink")}
          </Link>
          {t("home.serverUnreachableAfter")}
        </div>
      )}

      {/* 主体:桌面双栏一屏;移动单列纵排(列表内部滚动) */}
      <main className="flex-1 flex flex-col md:flex-row gap-3 md:gap-4 px-4 md:px-6 pb-4 md:pb-6 pt-3 min-h-0">
        {/* 左栏:操作入口 */}
        <section className="w-full md:w-2/5 md:max-w-sm flex flex-col gap-3 md:gap-4 min-h-0 shrink-0">
          <button
            onClick={handleCreateNew}
            className="shrink-0 h-16 md:h-28 rounded-xl md:rounded-2xl bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-base md:text-lg font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg flex items-center justify-center gap-2"
          >
            <span className="text-xl md:text-2xl">＋</span> {t("home.createBtn")}
          </button>

          <form
            onSubmit={handleJoinRoom}
            className="shrink-0 bg-white rounded-2xl shadow-lg p-4 space-y-3"
          >
            <label
              htmlFor="roomCode"
              className="block text-sm font-medium text-gray-700"
            >
              {t("home.roomCode")}
            </label>
            <input
              type="text"
              id="roomCode"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder={t("home.roomCodePlaceholder")}
              maxLength={8}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-sm"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                className="flex-1 py-2.5 min-h-tap-44 rounded-lg bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 transition-colors"
              >
                {t("home.joinBtn")}
              </button>
              <button
                type="button"
                onClick={() => setScanOpen(true)}
                title={t("home.scanBtnTitle")}
                className="px-4 py-2.5 min-h-tap-44 rounded-lg border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50 transition-colors"
              >
                <ScanIcon className="inline-block size-4" />{" "}
                <span className="hidden sm:inline">{t("home.scanBtn")}</span>
              </button>
            </div>
          </form>

          {/* 特性单行:桌面专属(移动空间优先给列表) */}
          <div className="hidden md:flex mt-auto shrink-0 bg-white/70 rounded-xl px-4 py-3 text-xs text-gray-500 flex-wrap gap-x-4 gap-y-1">
            <span>🔒 {t("home.featureSyncTitle")}</span>
            <span>📝 {t("home.featureRichTitle")}</span>
            <span>💾 {t("home.offlineWritable")}</span>
            <span>
              <ScanIcon className="inline-block size-3.5 align-[-2px]" />{" "}
              {t("home.scanBtnTitle")}
            </span>
          </div>
        </section>

        {/* 右栏:房间列表(桌面主体) */}
        <section className="w-full flex-1 bg-white rounded-2xl shadow-lg flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
            <div className="flex gap-1">
              <button
                onClick={() => {
                  setTab("mine");
                  setSelected(new Set());
                }}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  tab === "mine"
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {t("home.myRooms")}
              </button>
              <button
                onClick={() => setTab("online")}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  tab === "online"
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {t("home.onlineTab")}
              </button>
            </div>

            {tab === "mine" &&
              (batch ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      setSelected(
                        allSelected ? new Set() : new Set(myRooms.map((r) => r.code))
                      )
                    }
                    className="text-xs text-gray-500 hover:text-blue-600"
                  >
                    {allSelected ? t("common.cancel") : t("home.selectAll")}
                  </button>
                  <button
                    onClick={leaveSelected}
                    disabled={selected.size === 0}
                    className="text-xs px-3 py-1.5 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 disabled:opacity-40 transition-colors"
                  >
                    {t("home.leaveSelected")}
                    {selected.size > 0 ? ` (${selected.size})` : ""}
                  </button>
                  <button
                    onClick={() => {
                      setBatch(false);
                      setSelected(new Set());
                    }}
                    className="text-xs px-2 py-1.5 text-gray-500 hover:text-gray-600"
                  >
                    {t("home.batchDone")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setBatch(true)}
                  disabled={myRooms.length === 0}
                  className="text-xs text-gray-500 hover:text-blue-600 disabled:opacity-40"
                >
                  ⚙ {t("home.batchBtn")}
                </button>
              ))}
          </div>

          {/* 列表:内部滚动,整页不滚 */}
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {tab === "mine" ? (
              myRooms.length === 0 ? (
                <p className="text-sm text-gray-500 py-12 text-center">
                  {t("home.recentEmpty")}
                </p>
              ) : (
                <ul className="space-y-1">
                  {myRooms.map((room) => (
                    <li key={room.code}>
                      {/* 两行式(窄屏自动换行):行1 名称+码;行2 状态+操作;按钮 ≥40px */}
                      <div className="group flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 rounded-lg hover:bg-blue-50 transition-colors">
                        {batch && (
                          <input
                            type="checkbox"
                            checked={selected.has(room.code)}
                            onChange={() => toggleSelect(room.code)}
                            className="shrink-0 size-5 accent-blue-600"
                            aria-label={room.name || room.code}
                          />
                        )}
                        <button
                          onClick={() => !batch && enterRoom(room.code)}
                          disabled={batch}
                          className="flex-1 min-w-[9rem] flex items-center gap-2 text-left py-1.5 disabled:cursor-default"
                        >
                          <span className="font-medium text-gray-900 truncate">
                            {room.name || t("common.unnamedDoc")}
                          </span>
                          <code className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-mono shrink-0">
                            {room.code}
                          </code>
                        </button>
                        <span className="text-xs text-gray-500 shrink-0 order-3 md:order-none w-full md:w-auto pl-1 md:pl-0">
                          {room.userCount > 0 ? (
                            <span className="text-green-600">
                              ● {t("home.nOnline", { n: room.userCount })}
                            </span>
                          ) : (
                            <span>
                              {t("home.lastUsed")} {formatRelative(room.lastUsed, locale)}
                            </span>
                          )}
                        </span>
                        <div className="flex items-center shrink-0 ml-auto md:ml-0">
                          <button
                            onClick={() => setQrFor(room.code)}
                            title={t("home.showQrTitle")}
                            className="text-gray-500 hover:text-blue-600 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                          >
                            ▦
                          </button>
                          <button
                            onClick={() => leaveSingle(room.code)}
                            title={t("home.leaveSingleTitle")}
                            className="text-gray-500 hover:text-red-500 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : onlineRooms.length === 0 ? (
              <p className="text-sm text-gray-500 py-12 text-center">
                {t("home.onlineEmpty")}
              </p>
            ) : (
              <ul className="space-y-1">
                {onlineRooms.map((room) => (
                  <li key={room.code}>
                    <div className="group flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 rounded-lg hover:bg-blue-50 transition-colors">
                      <button
                        onClick={() => enterRoom(room.code)}
                        className="flex-1 min-w-[9rem] flex items-center gap-2 text-left py-1.5"
                      >
                        <code className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded font-mono shrink-0">
                          {room.code}
                        </code>
                        <span className="font-medium text-gray-900 truncate">
                          {nameByCode.get(room.code) || t("common.onlineRoom")}
                        </span>
                      </button>
                      <span className="text-xs text-green-600 shrink-0">
                        ● {t("home.nOnline", { n: room.userCount })}
                      </span>
                      <button
                        onClick={() => setQrFor(room.code)}
                        title={t("home.showQrTitle")}
                        className="text-gray-500 hover:text-blue-600 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg shrink-0"
                      >
                        ▦
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      {/* 二维码 / 扫码弹层 */}
      {qrFor && (
        <QrModal
          url={buildJoinUrl(serverBase, qrFor)}
          title={t("qrModal.title")}
          desc={t("qrModal.desc", { code: qrFor })}
          onClose={() => setQrFor(null)}
        />
      )}
      {shareSite && (
        <QrModal
          url={serverBase}
          title={t("qrModal.siteTitle")}
          onClose={() => setShareSite(false)}
        />
      )}
      {scanOpen && (
        <ScanModal onResult={handleScanResult} onClose={() => setScanOpen(false)} />
      )}
    </div>
  );
}

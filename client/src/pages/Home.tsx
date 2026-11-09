import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { upsertRecentRoom } from "@/lib/storage";
import { formatRelative } from "@/lib/roomCode";
import { getServerBase, saveServer } from "@/lib/serverConfig";
import { buildJoinUrl } from "@/lib/qr";
import {
  authFetch,
  cacheRooms,
  clearAllLocalData,
  clearRoomCache,
  logoutRemote,
  readCachedRooms,
  useAccount,
} from "@/lib/auth";
import { fetchPairings, type PairingInfo } from "@/lib/pairing";
import { createDoc, getDocStatus, deleteDoc } from "@/lib/docs";
import { parseIntake } from "@/lib/intake";
import { useT } from "@/i18n";
import { QrModal } from "@/components/QrModal";
import { ScanModal } from "@/components/ScanModal";
import { PairModal } from "@/components/PairModal";
import { TrashModal } from "@/components/TrashModal";
import { DocPane } from "@/components/DocPane";
import { Menu, MenuItem } from "@/components/Menu";
import { Avatar } from "@/components/Avatar";
import { DeleteOutlined, QrcodeOutlined, ScanOutlined, CloseOutlined } from "@ant-design/icons";
import { isDesktopTauri } from "@/platform";
import { onTrayAction, pushRecentRooms } from "@/platform/tray";
import { useBackHandler } from "@/platform/backButton";
import { docTitle } from "@/lib/docTitle";
import { useServerReachable } from "@/lib/connectivity";
import { OfflineTag } from "@/components/OfflineTag";
import { useIsMobile } from "@/lib/useIsMobile";
import { MobileHome } from "@/components/mobile/MobileHome";
import { MobileDocView } from "@/components/mobile/MobileDocView";
import type { MyRoom } from "@/types";

export default function Home() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, locale } = useT();
  const { account } = useAccount();
  const serverBase = useMemo(() => getServerBase(), []);
  // 移动端(<768px)整页换成原生化界面(components/mobile/);桌面双栏不变
  const isMobile = useIsMobile();

  // ?join=CODE:扫码落地(未登录设备登录后转来)预填房间码
  const [roomCode, setRoomCode] = useState(
    () => (searchParams.get("join") ?? "").toUpperCase().slice(0, 8)
  );
  // 离线冷启动先用上次在线的房间簿(在线人数归零),联网成功后覆盖并刷新快照
  const [myRooms, setMyRooms] = useState<MyRoom[]>(
    () => readCachedRooms<MyRoom>()?.map((r) => ({ ...r, userCount: 0 })) ?? []
  );
  const roomsFromServer = useCallback((rooms: MyRoom[]) => {
    setMyRooms(rooms);
    cacheRooms(rooms);
  }, []);
  // 连通性是全局状态(lib/connectivity):authFetch 的成败自动上报,这里只读
  const serverOk = useServerReachable();
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [shareSite, setShareSite] = useState(false);
  // 配对登录:弹窗开关 + 未清扫配对列表(红点/弹窗共用)
  const [pairOpen, setPairOpen] = useState(false);
  const [pairings, setPairings] = useState<PairingInfo[]>([]);
  // 红点来源:/rooms 的 pendingPairings(V11,任一已登录设备可确认)
  const [pendingPairings, setPendingPairings] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false);
  const [liveNames, setLiveNames] = useState<Record<string, { name: string; at: number }>>({});
  // 右栏选中的文档(v4.0 联调反馈图9:列表选中 → 原地展示可编辑内容)
  const [activeCode, setActiveCode] = useState<string | null>(null);
  // Android 返回键:文档面板打开时(移动端全屏接管)先回列表,而不是直接退出 App
  useBackHandler(activeCode !== null, () => setActiveCode(null));

  // 我的房间(memberships ⨝ docs;/health 仅作连通探测,L18 不再列文档码)
  const fetchMine = useCallback(async () => {
    try {
      const res = await authFetch(`${getServerBase()}/rooms`);
      // 非 2xx 不当作「列表为空」:否则一次服务端报错就把离线快照覆盖成空
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      roomsFromServer(Array.isArray(data?.rooms) ? data.rooms : []);
      setPendingPairings(Number(data?.pendingPairings ?? 0));
    } catch {
      /* 离线:保留离线快照;连通性已由 authFetch 上报 */
    }
  }, [roomsFromServer]);

  // 服务器从离线恢复:立即刷新列表(不等 15s 轮询);启动时 null→true 不重复拉
  const wasOffline = useRef(false);
  useEffect(() => {
    if (serverOk === false) wasOffline.current = true;
    else if (serverOk && wasOffline.current) {
      wasOffline.current = false;
      void fetchMine();
    }
  }, [serverOk, fetchMine]);

  // 离开/切换文档立即刷新列表:刚写的正文开头(未命名文档的列表标题)不必等 15s 轮询
  const prevActive = useRef(activeCode);
  useEffect(() => {
    if (prevActive.current && prevActive.current !== activeCode) void fetchMine();
    prevActive.current = activeCode;
  }, [activeCode, fetchMine]);

  useEffect(() => {
    fetchMine();
    const id = window.setInterval(fetchMine, 15000);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchMine();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchMine]);

  // 配对状态轮询(D13):有待确认或弹窗开着才轮询(1s/5s),清空即停
  const refreshPairings = useCallback(() => {
    fetchPairings()
      .then(setPairings)
      .catch(() => {
        /* 401 由 authFetch 统一处理;网络失败静默 */
      });
  }, []);
  const hasPairings = pairings.length > 0;
  useEffect(() => {
    if (!hasPairings && !pairOpen && pendingPairings === 0) return;
    refreshPairings();
    const id = window.setInterval(refreshPairings, pairOpen ? 1000 : 5000);
    return () => window.clearInterval(id);
  }, [hasPairings, pairOpen, pendingPairings, refreshPairings]);
  const pairNeedsConfirm = pendingPairings > 0 || pairings.some((p) => p.status === "claimed");

  // 文档不可用(状态查询 missing/trashed,或协同 WS 4004/4010):仍是当前文档才关面板 + 提示,
  // 两条来源先到先得,不重复弹窗
  const activeRef = useRef(activeCode);
  useEffect(() => {
    activeRef.current = activeCode;
  }, [activeCode]);
  const closeUnavailable = useCallback(
    (code: string, kind: "missing" | "trashed") => {
      if (activeRef.current !== code) return;
      activeRef.current = null;
      setActiveCode(null);
      if (kind === "missing") clearRoomCache(code);
      void fetchMine();
      alert(kind === "trashed" ? t("docs.trashedAlert") : t("docs.missingAlert"));
    },
    [fetchMine, t]
  );

  // 统一打开文档:立即打开面板(本机 IndexedDB 先出内容,离线照样能编辑),状态查询与登记在后台进行。
  // 以前先 await 状态查询再打开 —— 服务器不可达时 fetch 一挂就是几十秒,表现为「离线打不开文档」。
  const enterRoom = useCallback(
    (code: string) => {
      const upper = code.toUpperCase().slice(0, 8);
      activeRef.current = upper;
      setActiveCode(upper);
      getDocStatus(upper)
        .then((st) => {
          if (st.status !== "active") closeUnavailable(upper, st.status);
        })
        .catch(() => {
          /* 离线/超时:凭本机缓存继续编辑,联网后协同 WS 自会校验(4004/4010) */
        });
      const existing = myRooms.find((r) => r.code === upper)?.name ?? "";
      authFetch(`${getServerBase()}/rooms/enter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: upper }),
      })
        .then((r) => r.json())
        .then((d) => Array.isArray(d?.rooms) && roomsFromServer(d.rooms))
        .catch(() => {
          /* 登记失败不阻断进房 */
        });
      upsertRecentRoom({ code: upper, name: existing });
    },
    [myRooms, closeUnavailable, roomsFromServer]
  );

  // ?open=CODE:直接打开某文档(移动端扫码落地经 /editor 转来);处理一次后清掉参数
  const openedRef = useRef(false);
  useEffect(() => {
    const code = searchParams.get("open");
    if (!code || openedRef.current) return;
    openedRef.current = true;
    enterRoom(code);
    navigate("/", { replace: true });
  }, [searchParams, enterRoom, navigate]);

  // 新建:服务端生成码,创建者即所有者;直接在右栏打开
  const handleCreateNew = async () => {
    // 文档码由服务端分配,离线建不了;直接说清楚,而不是笼统的「创建失败」
    if (serverOk === false) {
      alert(t("offline.createBlocked"));
      return;
    }
    try {
      const { code } = await createDoc();
      upsertRecentRoom({ code, name: "" });
      setActiveCode(code);
      void fetchMine();
    } catch {
      alert(t("docs.createFail"));
    }
  };

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

  // 扫码/粘贴 → 统一 intake:join 进房;pair 转落地页(push 登录 / pull 批准由它分派)
  const handleScanResult = (text: string) => {
    setScanOpen(false);
    const intake = parseIntake(text);
    if (!intake) {
      alert(t("home.alertInvalidQr"));
      return;
    }
    if (intake.type === "join") {
      if (intake.server) saveServer(intake.server);
      setRoomCode(intake.code);
      enterRoom(intake.code);
      return;
    }
    if (intake.type === "pair") {
      if (intake.server) saveServer(intake.server);
      navigate(`/pair?code=${encodeURIComponent(intake.code)}${intake.server ? `&server=${encodeURIComponent(intake.server)}` : ""}`);
      return;
    }
    saveServer(intake.server);
  };

  // 退出房间(单个/批量):服务端解除关联;退出即清本机缓存(L17)
  const doLeave = async (codes: string[]) => {
    try {
      const res = await authFetch(`${getServerBase()}/rooms/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes }),
      });
      const data = await res.json();
      if (Array.isArray(data?.rooms)) roomsFromServer(data.rooms);
      if (activeCode && codes.includes(activeCode)) setActiveCode(null);
      for (const c of codes) clearRoomCache(c);
    } catch {
      /* 401 统一处理 */
    }
  };

  const roomLabel = (code: string) => {
    const room = myRooms.find((r) => r.code === code);
    return room ? docTitle(room, t("common.unnamedDoc")) : t("common.unnamedDoc");
  };

  const leaveSingle = (code: string) => {
    if (!window.confirm(t("home.leaveSingleConfirm", { code: roomLabel(code) }))) return;
    void doLeave([code]);
  };

  // 所有者删除:进回收站,所有成员立即无法访问(30 天可恢复)
  const deleteSingle = async (code: string) => {
    if (!window.confirm(t("docs.deleteConfirm", { name: roomLabel(code) }))) return;
    try {
      await deleteDoc(code);
      if (activeCode === code) setActiveCode(null);
      await fetchMine();
    } catch {
      alert(t("docs.deleteFail"));
    }
  };

  // 移动端多选删除(确认已由 MobileHome 完成):自有文档进回收站,共享文档退出
  const removeMany = async (own: string[], joined: string[]) => {
    if (joined.length) await doLeave(joined);
    if (own.length) {
      const results = await Promise.allSettled(own.map((c) => deleteDoc(c)));
      if (results.some((r) => r.status === "rejected")) alert(t("docs.deleteFail"));
      if (activeCode && own.includes(activeCode)) setActiveCode(null);
      await fetchMine();
    }
  };

  // 面板内文档不可用(4004/4010):关面板 + 刷列表
  const handlePaneUnavailable = closeUnavailable;

  // 退出登录 = 服务端吊销本机凭据 + 清全部本地(凭据/文档缓存/最近房间)
  const logout = async () => {
    if (!window.confirm(t("topbar.logoutConfirm"))) return;
    await logoutRemote();
    clearAllLocalData();
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
  const createRef = useRef(handleCreateNew);
  createRef.current = handleCreateNew;
  useEffect(() => {
    if (!isDesktopTauri()) return;
    let disposed = false;
    let un: (() => void) | undefined;
    onTrayAction((action) => {
      if (action.type === "new") void createRef.current();
      else void enterRef.current(action.code);
    }).then((u) => (disposed ? u() : (un = u)));
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const activeRooms = myRooms.filter((r) => r.status === "active");
  // 移动端列表叠加文档页里刚同步到的共享名(服务端落库有 2s 去抖,关文档立即刷新会拿到旧名);
  // 30s 后让位于服务端数据,避免长期遮住别人后来的改名
  const mobileRooms = activeRooms.map((r) => {
    const live = liveNames[r.code];
    return live && live.name !== r.name && Date.now() - live.at < 30_000 ? { ...r, name: live.name } : r;
  });

  const modals = (
    <>
      {qrFor && (
        <QrModal
          url={buildJoinUrl(serverBase, qrFor)}
          title={t("qrModal.title")}
          desc={t("qrModal.desc", { code: qrFor })}
          onClose={() => setQrFor(null)}
        />
      )}
      {shareSite && (
        <QrModal url={serverBase} title={t("qrModal.siteTitle")} onClose={() => setShareSite(false)} />
      )}
      {scanOpen && <ScanModal onResult={handleScanResult} onClose={() => setScanOpen(false)} />}
      {pairOpen && (
        <PairModal
          pairings={pairings}
          refresh={refreshPairings}
          onClose={() => setPairOpen(false)}
        />
      )}
      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} onChanged={fetchMine} />}
    </>
  );

  if (isMobile) {
    return (
      <>
        <MobileHome
          covered={activeCode !== null}
          rooms={mobileRooms}
          serverOk={serverOk}
          accountName={account?.name ?? t("common.anonymous")}
          accountId={account?.id}
          pairNeedsConfirm={pairNeedsConfirm}
          initialJoinCode={roomCode}
          onOpen={(code) => enterRoom(code)}
          onCreate={() => void handleCreateNew()}
          onScan={() => setScanOpen(true)}
          onShare={setQrFor}
          onRemove={(own, joined) => void removeMany(own, joined)}
          onPair={() => setPairOpen(true)}
          onTrash={() => setTrashOpen(true)}
          onSettings={() => navigate("/settings")}
          onShareSite={() => setShareSite(true)}
          onLogout={() => void logout()}
        />
        {activeCode && account && (
          <MobileDocView
            code={activeCode}
            initialName={mobileRooms.find((r) => r.code === activeCode)?.name}
            userName={account.name}
            userId={account.id}
            onClose={() => {
              setActiveCode(null);
              void fetchMine(); // 改名等变化立即回到列表
            }}
            onUnavailable={handlePaneUnavailable}
            onDelete={(code) => void deleteSingle(code)}
            onLeave={leaveSingle}
            onNameChange={(code, name) =>
              setLiveNames((m) => (m[code]?.name === name ? m : { ...m, [code]: { name, at: Date.now() } }))
            }
          />
        )}
        {modals}
      </>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-blue-50 to-indigo-100 overflow-hidden pt-[env(safe-area-inset-top)] box-border">
      {/* 顶栏:品牌居左;右上角用户名 + 头像菜单(登录其他设备/回收站/设置/分享/退出) */}
      <header className="flex items-center gap-4 px-6 py-3 shrink-0">
        <div className="hidden md:flex items-baseline gap-3 min-w-0 shrink">
          <h1 className="text-2xl font-bold text-gray-900 shrink-0">{t("common.appName")}</h1>
          {serverOk === false && <OfflineTag className="self-center" />}
          <p className="text-sm text-gray-500 truncate hidden lg:block">{t("common.taglineShort")}</p>
        </div>
        {/* 加入/新建拆进顶栏(联调反馈):文档码输入(扫码作 suffix) + 加入 + 新建,左栏只留列表 */}
        <form onSubmit={handleJoinRoom} className="ml-auto flex items-center gap-2 shrink-0">
          <div className="relative w-44 lg:w-60">
            <input
              type="text"
              id="roomCode"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder={t("home.roomCodePlaceholder")}
              aria-label={t("home.roomCodePlaceholder")}
              maxLength={8}
              className="w-full h-10 pl-3 pr-10 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setScanOpen(true)}
              title={t("home.scanBtnTitle")}
              aria-label={t("home.scanBtn")}
              className="absolute right-1 top-1/2 -translate-y-1/2 size-8 flex items-center justify-center rounded-md text-gray-500 hover:text-blue-600 hover:bg-gray-100 transition-colors"
            >
              <ScanOutlined className="text-base" />
            </button>
          </div>
          <button
            type="submit"
            className="h-10 px-4 rounded-lg bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 transition-colors whitespace-nowrap"
          >
            {t("home.joinBtn")}
          </button>
          <button
            type="button"
            onClick={() => void handleCreateNew()}
            className="h-10 px-4 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-sm font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow flex items-center gap-1 whitespace-nowrap"
          >
            <span>＋</span> {t("home.createBtn")}
          </button>
        </form>
        <div className="h-6 w-px bg-gray-300/70 shrink-0" />
        {/* 身份区必须贴右(加入表单的 ml-auto 把它推过去),否则头像菜单面板锚在屏幕中段、
            右对齐展开后被左缘裁掉(真机实踩) */}
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          <span className="text-sm text-gray-700 font-medium truncate max-w-[10rem]">
            {account?.name ?? t("common.anonymous")}
          </span>
          <Menu
            buttonTitle={t("home.accountMenuTitle")}
            buttonClassName="flex items-center justify-center rounded-full p-1 min-w-tap-40 min-h-tap-40 hover:bg-white/70 transition-colors"
            buttonContent={
              <div className="relative">
                <Avatar name={account?.name ?? t("common.anonymous")} id={account?.id} />
                {pairNeedsConfirm && (
                  <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-red-500 ring-2 ring-white" />
                )}
              </div>
            }
          >
            <MenuItem onClick={() => setPairOpen(true)}>
              {t("pair.entry")}
              {pairNeedsConfirm ? " ●" : ""}
            </MenuItem>
            <MenuItem onClick={() => setTrashOpen(true)}>{t("trash.entry")}</MenuItem>
            <MenuItem onClick={() => navigate("/settings")}>{t("home.settingsLink")}</MenuItem>
            <MenuItem onClick={() => setShareSite(true)}>{t("home.shareSite")}</MenuItem>
            <MenuItem onClick={() => void logout()} className="text-red-600">
              {t("topbar.logout")}
            </MenuItem>
          </Menu>
        </div>
      </header>

      {/* 主体:桌面双栏一屏;移动单列纵排(列表内部滚动) */}
      <main className="flex-1 flex flex-col md:flex-row gap-3 md:gap-4 px-4 md:px-6 pb-4 md:pb-6 pt-3 min-h-0">
        {/* 左栏:我的文档列表(加入/新建已移到顶栏) */}
        <section
          className={`w-full md:w-80 flex flex-col gap-3 min-h-0 shrink-0 ${
            activeCode ? "hidden md:flex" : "flex"
          }`}
        >

          {/* 我的文档(服务端房间簿;列表内滚,一屏无外滚) */}
          <div className="flex-1 min-h-0 bg-white rounded-2xl shadow-lg flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
              <span className="text-sm font-medium text-gray-700">{t("home.myRooms")}</span>
            </div>

            <div className="flex-1 overflow-y-auto px-2 py-2">
              {/* 主列表只放 active 文档:回收站内容走头像菜单的回收站弹窗(恢复/清理都在那)。
                  混排一列灰显「未命名文档·回收站」对用户全是噪音(v4 联调实踩)。 */}
              {activeRooms.length === 0 ? (
                <p className="text-sm text-gray-500 py-12 text-center">{t("home.recentEmpty")}</p>
              ) : (
                <ul className="space-y-1">
                  {activeRooms.map((room) => {
                    return (
                      <li key={room.code} className="relative">
                        {/* 整行可点:覆盖层按钮铺满行(操作按钮/复选框 z-10 置于其上)。
                            单行不换行 —— 文档名截断,「上次使用/在线人数」作第二行小字。 */}
                        <div
                          aria-current={activeCode === room.code ? "true" : undefined}
                          className={`group flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                            activeCode === room.code ? "bg-blue-100/80" : "hover:bg-blue-50"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => enterRoom(room.code)}
                            aria-label={docTitle(room, t("common.unnamedDoc"))}
                            className="absolute inset-0 z-0 rounded-lg"
                          />
                          <div className="pointer-events-none min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`font-medium truncate ${
                                  activeCode === room.code ? "text-blue-600" : "text-gray-900"
                                }`}
                              >
                                {docTitle(room, t("common.unnamedDoc"))}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500 truncate mt-0.5">
                              {room.userCount > 0 ? (
                                <span className="text-green-600">
                                  ● {t("home.nOnline", { n: room.userCount })}
                                </span>
                              ) : (
                                <>
                                  {t("home.lastUsed")} {formatRelative(room.lastUsed, locale)}
                                </>
                              )}
                            </p>
                          </div>
                          <div className="relative z-10 flex items-center shrink-0">
                            <button
                              onClick={() => setQrFor(room.code)}
                              title={t("home.showQrTitle")}
                              className="text-gray-500 hover:text-blue-600 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                            >
                              <QrcodeOutlined className="text-lg" />
                            </button>
                            {room.isOwner ? (
                              <button
                                onClick={() => void deleteSingle(room.code)}
                                title={t("docs.deleteBtnTitle")}
                                className="text-gray-500 hover:text-red-500 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                              >
                                <DeleteOutlined className="text-lg" />
                              </button>
                            ) : (
                              <button
                                onClick={() => leaveSingle(room.code)}
                                title={t("home.leaveSingleTitle")}
                                className="text-gray-500 hover:text-red-500 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                              >
                                <CloseOutlined className="text-lg" />
                              </button>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="hidden md:flex shrink-0 bg-white/70 rounded-xl px-4 py-3 text-xs text-gray-500 flex-wrap gap-x-4 gap-y-1">
            <span>🔒 {t("home.featureSyncTitle")}</span>
            <span>📝 {t("home.featureRichTitle")}</span>
            <span>💾 {t("home.offlineWritable")}</span>
          </div>
        </section>

        {/* 右栏:选中文档的原地编辑面板(图9);未选中=占位。移动端 activeCode 时全屏接管 */}
        <section
          className={`w-full flex-1 min-h-0 ${
            activeCode ? "flex" : "hidden md:flex"
          } flex-col bg-white/60 rounded-2xl shadow-lg overflow-hidden`}
        >
          {activeCode && account ? (
            <DocPane
              // 按文档码重挂:切换文档时内容/在线用户/文档名等状态全部从零开始,不带上一篇的残影
              key={activeCode}
              code={activeCode}
              userName={account.name}
              userId={account.id}
              onClose={() => setActiveCode(null)}
              onUnavailable={handlePaneUnavailable}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-2">
              <p className="text-base font-medium text-gray-600">{t("home.paneEmptyTitle")}</p>
              <p className="text-sm text-gray-400 max-w-sm leading-relaxed">
                {t("home.paneEmptyDesc")}
              </p>
            </div>
          )}
        </section>
      </main>

      {modals}
    </div>
  );
}

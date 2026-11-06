import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { upsertRecentRoom } from "@/lib/storage";
import { formatRelative } from "@/lib/roomCode";
import { getServerBase, saveServer } from "@/lib/serverConfig";
import { buildJoinUrl } from "@/lib/qr";
import { authFetch, clearAllLocalData, clearRoomCache, logoutRemote, useAccount } from "@/lib/auth";
import { fetchPairings, type PairingInfo } from "@/lib/pairing";
import { createDoc, getDocStatus, deleteDoc } from "@/lib/docs";
import { parseIntake } from "@/lib/intake";
import { useT } from "@/i18n";
import { QrModal } from "@/components/QrModal";
import { ScanModal } from "@/components/ScanModal";
import { PairModal } from "@/components/PairModal";
import { TrashModal } from "@/components/TrashModal";
import { Menu, MenuItem } from "@/components/Menu";
import { Avatar } from "@/components/Avatar";
import { ScanIcon } from "@/components/icons";
import { isDesktopTauri } from "@/platform";
import { onTrayAction, pushRecentRooms } from "@/platform/tray";

type MyRoom = {
  code: string;
  name: string;
  lastUsed: number;
  userCount: number;
  status: "active" | "trashed";
  isOwner: boolean;
};

export default function Home() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, locale } = useT();
  const { account } = useAccount();
  const serverBase = useMemo(() => getServerBase(), []);

  // ?join=CODE:扫码落地(未登录设备登录后转来)预填房间码
  const [roomCode, setRoomCode] = useState(
    () => (searchParams.get("join") ?? "").toUpperCase().slice(0, 8)
  );
  const [myRooms, setMyRooms] = useState<MyRoom[]>([]);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [shareSite, setShareSite] = useState(false);
  // 配对登录:弹窗开关 + 未清扫配对列表(红点/弹窗共用)
  const [pairOpen, setPairOpen] = useState(false);
  const [pairings, setPairings] = useState<PairingInfo[]>([]);
  // 红点来源:/rooms 的 pendingPairings(V11,任一已登录设备可确认)
  const [pendingPairings, setPendingPairings] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false);
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 我的房间(memberships ⨝ docs;/health 仅作连通探测,L18 不再列文档码)
  const fetchMine = useCallback(async () => {
    try {
      const res = await authFetch(`${getServerBase()}/rooms`);
      const data = await res.json();
      setMyRooms(Array.isArray(data?.rooms) ? data.rooms : []);
      setPendingPairings(Number(data?.pendingPairings ?? 0));
      setServerOk(true);
    } catch {
      setServerOk(false);
    }
  }, []);

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

  // 统一进入房间:先查状态(L4 显式语义,不再隐式创建)→ 登记 → 跳转
  const enterRoom = useCallback(
    async (code: string) => {
      const upper = code.toUpperCase().slice(0, 8);
      try {
        const st = await getDocStatus(upper);
        if (st.status === "missing") {
          alert(t("docs.missingAlert"));
          return;
        }
        if (st.status === "trashed") {
          alert(t("docs.trashedAlert"));
          return;
        }
      } catch {
        /* 状态查询失败不阻断(离线时凭缓存进入) */
      }
      const existing = myRooms.find((r) => r.code === upper)?.name ?? "";
      authFetch(`${getServerBase()}/rooms/enter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: upper }),
      })
        .then((r) => r.json())
        .then((d) => Array.isArray(d?.rooms) && setMyRooms(d.rooms))
        .catch(() => {
          /* 登记失败不阻断进房 */
        });
      upsertRecentRoom({ code: upper, name: existing });
      navigate(`/editor?code=${upper}&name=${encodeURIComponent(account?.name ?? "")}`);
    },
    [myRooms, account, navigate, t]
  );

  // 新建:服务端生成码,创建者即所有者
  const handleCreateNew = async () => {
    try {
      const { code } = await createDoc();
      upsertRecentRoom({ code, name: "" });
      navigate(`/editor?code=${code}&name=${encodeURIComponent(account?.name ?? "")}`);
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
    void enterRoom(code);
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
      void enterRoom(intake.code);
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
      if (Array.isArray(data?.rooms)) setMyRooms(data.rooms);
      setSelected(new Set());
      for (const c of codes) clearRoomCache(c);
    } catch {
      /* 401 统一处理 */
    }
  };

  const leaveSingle = (code: string) => {
    if (!window.confirm(t("home.leaveSingleConfirm", { code }))) return;
    void doLeave([code]);
  };

  // 所有者删除:进回收站,所有成员立即无法访问(30 天可恢复)
  const deleteSingle = async (code: string) => {
    if (!window.confirm(t("docs.deleteConfirm", { code }))) return;
    try {
      await deleteDoc(code);
      await fetchMine();
    } catch {
      alert(t("docs.deleteFail"));
    }
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

  const selectableRooms = myRooms.filter((r) => r.status === "active" && !r.isOwner);
  const allSelected = selectableRooms.length > 0 && selected.size === selectableRooms.length;

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-blue-50 to-indigo-100 overflow-hidden pt-[env(safe-area-inset-top)] box-border">
      {/* 顶栏:品牌居左;右上角用户名 + 头像菜单(登录其他设备/回收站/设置/分享/退出) */}
      <header className="flex items-center justify-between px-6 py-3 shrink-0">
        <div className="hidden md:flex items-baseline gap-3 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">{t("common.appName")}</h1>
          <p className="text-sm text-gray-500 truncate hidden md:block">{t("common.taglineShort")}</p>
        </div>
        <div className="flex items-center gap-2 min-w-0">
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

      {/* 服务器不可达细条引导 */}
      {serverOk === false && (
        <div className="mx-6 mb-2 rounded-lg bg-yellow-50 border border-yellow-200 px-4 py-2 text-sm text-yellow-800 shrink-0">
          {t("home.serverUnreachableBefore")}
          <Link to="/settings" className="font-semibold underline underline-offset-2">
            {t("home.serverUnreachableLink")}
          </Link>
          {t("home.serverUnreachableAfter")}
        </div>
      )}

      {/* 主体:桌面双栏一屏;移动单列纵排(列表内部滚动) */}
      <main className="flex-1 flex flex-col md:flex-row gap-3 md:gap-4 px-4 md:px-6 pb-4 md:pb-6 pt-3 min-h-0">
        <section className="w-full md:w-2/5 md:max-w-sm flex flex-col gap-3 md:gap-4 min-h-0 shrink-0">
          <form
            onSubmit={handleJoinRoom}
            className="shrink-0 bg-white rounded-2xl shadow-lg p-4 space-y-3"
          >
            <label htmlFor="roomCode" className="block text-sm font-medium text-gray-700">
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

          {/* 创建:次要动作放加入表单之下(原来是顶栏式巨块,v4.0 评审:太占首屏) */}
          <button
            onClick={() => void handleCreateNew()}
            className="shrink-0 w-full py-2.5 min-h-tap-44 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-sm font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow flex items-center justify-center gap-1.5"
          >
            <span>＋</span> {t("home.createBtn")}
          </button>

          <div className="hidden md:flex mt-auto shrink-0 bg-white/70 rounded-xl px-4 py-3 text-xs text-gray-500 flex-wrap gap-x-4 gap-y-1">
            <span>🔒 {t("home.featureSyncTitle")}</span>
            <span>📝 {t("home.featureRichTitle")}</span>
            <span>💾 {t("home.offlineWritable")}</span>
            <span>
              <ScanIcon className="inline-block size-3.5 align-[-2px]" /> {t("home.scanBtnTitle")}
            </span>
          </div>
        </section>

        {/* 右栏:我的房间(单页签;在线人数逐行显示) */}
        <section className="w-full flex-1 bg-white rounded-2xl shadow-lg flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
            <span className="text-sm font-medium text-gray-700">{t("home.myRooms")}</span>
            {batch ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() =>
                    setSelected(allSelected ? new Set() : new Set(selectableRooms.map((r) => r.code)))
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
                disabled={selectableRooms.length === 0}
                className="text-xs text-gray-500 hover:text-blue-600 disabled:opacity-40"
              >
                ⚙ {t("home.batchBtn")}
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2">
            {myRooms.length === 0 ? (
              <p className="text-sm text-gray-500 py-12 text-center">{t("home.recentEmpty")}</p>
            ) : (
              <ul className="space-y-1">
                {myRooms.map((room) => {
                  const trashed = room.status === "trashed";
                  return (
                    <li key={room.code} className={trashed ? "opacity-60" : undefined}>
                      <div className="group flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 rounded-lg hover:bg-blue-50 transition-colors">
                        {batch && !trashed && !room.isOwner && (
                          <input
                            type="checkbox"
                            checked={selected.has(room.code)}
                            onChange={() => toggleSelect(room.code)}
                            className="shrink-0 size-5 accent-blue-600"
                            aria-label={room.name || room.code}
                          />
                        )}
                        <button
                          onClick={() => !batch && !trashed && void enterRoom(room.code)}
                          disabled={batch || trashed}
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
                          {trashed ? (
                            <span className="text-gray-400">{t("docs.trashedTag")}</span>
                          ) : room.userCount > 0 ? (
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
                          {!trashed && (
                            <button
                              onClick={() => setQrFor(room.code)}
                              title={t("home.showQrTitle")}
                              className="text-gray-500 hover:text-blue-600 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                            >
                              ▦
                            </button>
                          )}
                          {trashed ? (
                            <button
                              onClick={() => leaveSingle(room.code)}
                              title={t("home.leaveSingleTitle")}
                              className="text-gray-400 hover:text-gray-600 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                            >
                              ✕
                            </button>
                          ) : room.isOwner ? (
                            <button
                              onClick={() => void deleteSingle(room.code)}
                              title={t("docs.deleteBtnTitle")}
                              className="text-gray-500 hover:text-red-500 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                            >
                              🗑
                            </button>
                          ) : (
                            <button
                              onClick={() => leaveSingle(room.code)}
                              title={t("home.leaveSingleTitle")}
                              className="text-gray-500 hover:text-red-500 p-2 min-w-tap-40 min-h-tap-40 flex items-center justify-center text-lg"
                            >
                              ✕
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
        </section>
      </main>

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
    </div>
  );
}

// 应用壳的文档状态(v5):首页、设置、语音便签共用同一份——侧栏在任何一页都要有
// 文档列表、离线态、账号与各类弹层,所以这些状态从首页上提到壳(components/AppShell.tsx)。
// 这里只管状态与动作,不含界面;v4 的同名逻辑原样搬来,行为不变。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { upsertRecentRoom } from "@/lib/storage";
import { getServerBase, saveServer } from "@/lib/serverConfig";
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
import { isDesktopTauri } from "@/platform";
import { onTrayAction, pushRecentRooms } from "@/platform/tray";
import { useBackHandler } from "@/platform/backButton";
import { docTitle } from "@/lib/docTitle";
import { useServerReachable } from "@/lib/connectivity";
import type { MyRoom } from "@/types";

export type DocUnavailableKind = "missing" | "trashed";

/** 从地址栏取 ?join=CODE(扫码落地,未登录设备登录后转来),截断到 8 位并大写。 */
function joinCodeFromParams(searchParams: URLSearchParams): string {
  return (searchParams.get("join") ?? "").toUpperCase().slice(0, 8);
}

export function useDocsStore() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { t, locale } = useT();
  const { account } = useAccount();

  // ?join=CODE:预填房间码并直接展开「加入文档」
  const [joinCode, setJoinCode] = useState(() => joinCodeFromParams(searchParams));
  const [joinOpen, setJoinOpen] = useState(() => joinCodeFromParams(searchParams).length > 0);

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
  // 配对登录:弹窗开关 + 未清扫配对列表(待确认标记/弹窗共用)
  const [pairOpen, setPairOpen] = useState(false);
  const [pairings, setPairings] = useState<PairingInfo[]>([]);
  // 待确认来源:/rooms 的 pendingPairings(任一已登录设备可确认)
  const [pendingPairings, setPendingPairings] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false);
  const [liveNames, setLiveNames] = useState<Record<string, { name: string; at: number }>>({});
  // 当前打开的文档(首页右栏 / 移动端全屏文档页)
  const [activeCode, setActiveCode] = useState<string | null>(null);
  // Android 返回键:文档页打开时(移动端全屏接管)先回列表,而不是直接退出 App
  useBackHandler(activeCode !== null, () => setActiveCode(null));

  // 地址栏带着 ?join= 进来(壳已挂载时只有 search 变化):同样预填并展开
  useEffect(() => {
    const code = joinCodeFromParams(searchParams);
    if (!code) return;
    setJoinCode(code);
    setJoinOpen(true);
  }, [searchParams]);

  // 我的房间(memberships ⨝ docs;/health 仅作连通探测,不列文档码)
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
    (code: string, kind: DocUnavailableKind) => {
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

  // 从侧栏/便签页打开文档:先回首页(壳内其他页没有文档区)
  const openDoc = useCallback(
    (code: string) => {
      if (location.pathname !== "/") navigate("/");
      setJoinOpen(false);
      enterRoom(code);
    },
    [location.pathname, navigate, enterRoom]
  );

  // 便签转文档:新建的空白文档带一段初始正文。seed 随打开的文档码交给文档区,
  // 由编辑器在首次同步时写入(setMarkdown + applyLocalChange),写完即清。
  const [seed, setSeed] = useState<{ code: string; text: string } | null>(null);
  const openDocWithSeed = useCallback(
    (code: string, text: string) => {
      setSeed({ code, text });
      openDoc(code);
    },
    [openDoc]
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
  const createNew = useCallback(async () => {
    // 文档码由服务端分配,离线建不了;直接说清楚,而不是笼统的「创建失败」
    if (serverOk === false) {
      alert(t("offline.createBlocked"));
      return;
    }
    try {
      const { code } = await createDoc();
      upsertRecentRoom({ code, name: "" });
      openDoc(code);
    } catch {
      alert(t("docs.createFail"));
    }
  }, [serverOk, t, openDoc]);

  const submitJoin = useCallback(() => {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      alert(t("home.alertNeedRoomCode"));
      document.getElementById("roomCode")?.focus();
      return;
    }
    setJoinOpen(false);
    openDoc(code);
  }, [joinCode, t, openDoc]);

  // 扫码/粘贴 → 统一 intake:join 进房;pair 转落地页(push 登录 / pull 批准由它分派)
  const handleScanResult = useCallback(
    (text: string) => {
      setScanOpen(false);
      const intake = parseIntake(text);
      if (!intake) {
        alert(t("home.alertInvalidQr"));
        return;
      }
      if (intake.type === "join") {
        if (intake.server) saveServer(intake.server);
        setJoinCode(intake.code);
        setJoinOpen(false);
        openDoc(intake.code);
        return;
      }
      if (intake.type === "pair") {
        if (intake.server) saveServer(intake.server);
        navigate(`/pair?code=${encodeURIComponent(intake.code)}${intake.server ? `&server=${encodeURIComponent(intake.server)}` : ""}`);
        return;
      }
      saveServer(intake.server);
    },
    [t, navigate, openDoc]
  );

  // 退出房间(单个/批量):服务端解除关联;退出即清本机缓存(L17)
  const doLeave = useCallback(
    async (codes: string[]) => {
      try {
        const res = await authFetch(`${getServerBase()}/rooms/leave`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes }),
        });
        const data = await res.json();
        if (Array.isArray(data?.rooms)) roomsFromServer(data.rooms);
        if (activeRef.current && codes.includes(activeRef.current)) {
          activeRef.current = null;
          setActiveCode(null);
        }
        for (const c of codes) clearRoomCache(c);
      } catch {
        /* 401 统一处理 */
      }
    },
    [roomsFromServer]
  );

  const roomLabel = useCallback(
    (code: string) => {
      const room = myRooms.find((r) => r.code === code);
      return room ? docTitle(room, t("common.unnamedDoc")) : t("common.unnamedDoc");
    },
    [myRooms, t]
  );

  // 成员退出共享文档(确认后)
  const leaveSingle = useCallback(
    (code: string) => {
      if (!window.confirm(t("home.leaveSingleConfirm", { code: roomLabel(code) }))) return;
      void doLeave([code]);
    },
    [doLeave, roomLabel, t]
  );

  // 所有者删除:进回收站,所有成员立即无法访问(30 天可恢复)
  const deleteSingle = useCallback(
    async (code: string) => {
      if (!window.confirm(t("docs.deleteConfirm", { name: roomLabel(code) }))) return;
      try {
        await deleteDoc(code);
        if (activeRef.current === code) {
          activeRef.current = null;
          setActiveCode(null);
        }
        await fetchMine();
      } catch {
        alert(t("docs.deleteFail"));
      }
    },
    [roomLabel, t, fetchMine]
  );

  // 移动端多选删除(确认已由 MobileHome 完成):自有文档进回收站,共享文档退出
  const removeMany = useCallback(
    async (own: string[], joined: string[]) => {
      if (joined.length) await doLeave(joined);
      if (own.length) {
        const results = await Promise.allSettled(own.map((c) => deleteDoc(c)));
        if (results.some((r) => r.status === "rejected")) alert(t("docs.deleteFail"));
        if (activeRef.current && own.includes(activeRef.current)) {
          activeRef.current = null;
          setActiveCode(null);
        }
        await fetchMine();
      }
    },
    [doLeave, t, fetchMine]
  );

  // 退出登录 = 服务端吊销本机凭据 + 清全部本地(凭据/文档缓存/最近房间)
  const logout = useCallback(async () => {
    if (!window.confirm(t("topbar.logoutConfirm"))) return;
    await logoutRemote();
    clearAllLocalData();
    navigate("/welcome", { replace: true });
  }, [t, navigate]);

  // 桌面:我的房间 → 托盘菜单;语言变化重建
  const activeRooms = useMemo(() => myRooms.filter((r) => r.status === "active"), [myRooms]);
  useEffect(() => {
    if (!isDesktopTauri()) return;
    pushRecentRooms(
      activeRooms.map(({ code, name, lastUsed }) => ({ code, name, lastUsed })),
      locale
    );
  }, [activeRooms, locale]);

  // 桌面:托盘动作(新建/直达房间)→ 回首页并执行(在设置、便签页也生效)
  const createRef = useRef(createNew);
  createRef.current = createNew;
  const openRef = useRef(openDoc);
  openRef.current = openDoc;
  useEffect(() => {
    if (!isDesktopTauri()) return;
    let disposed = false;
    let un: (() => void) | undefined;
    onTrayAction((action) => {
      if (action.type === "new") void createRef.current();
      else if (action.type === "open") openRef.current(action.code);
    }).then((u) => (disposed ? u() : (un = u)));
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // 移动端列表叠加文档页里刚同步到的共享名(服务端落库有 2s 去抖,关文档立即刷新会拿到旧名);
  // 30s 后让位于服务端数据,避免长期遮住别人后来的改名
  const mobileRooms = useMemo(
    () =>
      activeRooms.map((r) => {
        const live = liveNames[r.code];
        return live && live.name !== r.name && Date.now() - live.at < 30_000 ? { ...r, name: live.name } : r;
      }),
    [activeRooms, liveNames]
  );

  return {
    account,
    serverOk,
    activeRooms,
    mobileRooms,
    activeCode,
    setActiveCode,
    openDoc,
    openDocWithSeed,
    seed,
    setSeed,
    enterRoom,
    closeUnavailable,
    createNew,
    joinCode,
    setJoinCode,
    joinOpen,
    setJoinOpen,
    submitJoin,
    handleScanResult,
    leaveSingle,
    deleteSingle,
    removeMany,
    logout,
    fetchMine,
    // 弹层
    qrFor,
    showQr: setQrFor,
    scanOpen,
    setScanOpen,
    shareSite,
    setShareSite,
    pairOpen,
    setPairOpen,
    pairings,
    refreshPairings,
    pairNeedsConfirm,
    trashOpen,
    setTrashOpen,
    setLiveNames,
  };
}

export type DocsStore = ReturnType<typeof useDocsStore>;

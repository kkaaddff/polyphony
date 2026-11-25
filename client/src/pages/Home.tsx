// 首页(v5):桌面 = 侧栏(在 AppShell)+ 右栏稿纸(DocPane)或空状态;移动 = 原生化列表 + 文档页。
// 文档列表 / 离线态 / 账号 / 弹层都在应用壳(useDocsStore),这里只渲染主区。
import { useNavigate } from "react-router";
import { useShell } from "@/components/shellContext";
import type { DocsStore } from "@/lib/useDocsStore";
import { useT } from "@/i18n";
import { useIsMobile } from "@/lib/useIsMobile";
import { DocPane } from "@/components/DocPane";
import { MobileHome } from "@/components/mobile/MobileHome";
import { MobileDocView } from "@/components/mobile/MobileDocView";
import { isAndroidTauri } from "@/platform";
import { openNativeVoiceInput } from "@/platform/voiceInput";
import { getServerBase } from "@/lib/serverConfig";
import { getToken } from "@/lib/auth";
import { createDoc } from "@/lib/docs";

export default function Home() {
  const store = useShell();
  const isMobile = useIsMobile();
  return isMobile ? <HomeMobile store={store} /> : <HomeDesktop store={store} />;
}

function HomeDesktop({ store }: { store: DocsStore }) {
  const { activeCode, account, setActiveCode, closeUnavailable } = store;
  if (activeCode && account) {
    return (
      <DocPane
        // 按文档码重挂:切换文档时内容/在线用户/文档名全部从零开始,不带上一篇残影
        key={activeCode}
        code={activeCode}
        userName={account.name}
        userId={account.id}
        onClose={() => setActiveCode(null)}
        onUnavailable={closeUnavailable}
      />
    );
  }
  return <DocEmptyState />;
}

/** 空状态:五线谱上的三声部(相位互差 120°,靠纸色 halo 描边做上下穿插)。 */
function wavePath(phase: number): string {
  let d = "";
  for (let x = 0; x <= 560; x += 5) {
    const y = 80 + 32 * Math.sin((x / 140) * Math.PI * 2 + phase);
    d += `${x ? " L" : "M"}${x} ${y.toFixed(1)}`;
  }
  return d;
}
const WAVES = [
  { phase: 0, cls: "stroke-accent" },
  { phase: (Math.PI * 2) / 3, cls: "stroke-[#7dd3fc]" },
  { phase: (Math.PI * 4) / 3, cls: "stroke-ink opacity-85" },
];

function DocEmptyState() {
  const { t } = useT();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-hidden px-6">
      <span className="absolute top-7 right-9 font-display text-15 italic text-ink-4">
        Many voices. One score.
      </span>
      <svg
        viewBox="0 0 560 150"
        aria-hidden="true"
        className="w-[min(560px,80%)] [mask-image:linear-gradient(90deg,transparent,#000_16%,#000_84%,transparent)]"
      >
        <g className="stroke-line" strokeWidth="1">
          {[40, 60, 80, 100, 120].map((y) => (
            <line key={y} x1="0" y1={y} x2="560" y2={y} />
          ))}
        </g>
        <g fill="none" strokeLinecap="round">
          {WAVES.map((w) => (
            <path key={`h${w.phase}`} d={wavePath(w.phase)} className="stroke-paper" strokeWidth="12" />
          ))}
          {WAVES.map((w) => (
            <path key={w.phase} d={wavePath(w.phase)} className={w.cls} strokeWidth="4.5" />
          ))}
        </g>
      </svg>
      <h2 className="text-xl font-semibold tracking-[-0.01em] text-ink">{t("home.emptyTitle")}</h2>
      <p className="max-w-[360px] text-center text-sm leading-relaxed text-ink-3">{t("home.emptyDesc")}</p>
    </div>
  );
}

function HomeMobile({ store }: { store: DocsStore }) {
  const navigate = useNavigate();
  const { t, locale } = useT();
  const {
    account, mobileRooms, serverOk, pairNeedsConfirm, joinCode, activeCode,
    enterRoom, createNew, setScanOpen, showQr, removeMany, setPairOpen, setTrashOpen,
    setShareSite, logout, setActiveCode, fetchMine, deleteSingle, leaveSingle,
    closeUnavailable, setLiveNames,
  } = store;

  return (
    <>
      <MobileHome
        covered={activeCode !== null}
        rooms={mobileRooms}
        serverOk={serverOk}
        accountName={account?.name ?? t("common.anonymous")}
        accountId={account?.id}
        pairNeedsConfirm={pairNeedsConfirm}
        initialJoinCode={joinCode}
        onOpen={(code) => enterRoom(code)}
        onCreate={() => void createNew()}
        onScan={() => setScanOpen(true)}
        onShare={showQr}
        onRemove={(own, joined) => void removeMany(own, joined)}
        onPair={() => setPairOpen(true)}
        onTrash={() => setTrashOpen(true)}
        onSettings={() => navigate("/settings")}
        onNotes={() => navigate("/notes")}
        onVoiceInput={
          isAndroidTauri()
            ? () =>
                void openNativeVoiceInput({
                  serverUrl: getServerBase(),
                  token: getToken(),
                  locale,
                })
                  .then(async ({ toDoc }) => {
                    // 原生便签预览里点了「转文档」:以便签为正文新建一篇(首行作文档名)并打开
                    if (!toDoc) return;
                    try {
                      const name = toDoc.split("\n")[0].trim().slice(0, 40);
                      const { code } = await createDoc(name || undefined);
                      void fetchMine();
                      store.openDocWithSeed(code, toDoc);
                    } catch {
                      alert(t("notes.toDocFail"));
                    }
                  })
                  .catch(console.error)
            : undefined
        }
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
          onUnavailable={closeUnavailable}
          onDelete={(code) => void deleteSingle(code)}
          onLeave={leaveSingle}
          onNameChange={(code, name) =>
            setLiveNames((m) => (m[code]?.name === name ? m : { ...m, [code]: { name, at: Date.now() } }))
          }
        />
      )}
    </>
  );
}

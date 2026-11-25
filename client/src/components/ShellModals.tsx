// 应用壳的全局弹层:文档二维码 / 分享本站 / 扫码 / 配对登录 / 回收站。
// 首页、设置、便签页共用(状态都在 useDocsStore),桌面与移动同一套组件。
import { useShell } from "./shellContext";
import { useT } from "@/i18n";
import { buildJoinUrl } from "@/lib/qr";
import { getServerBase } from "@/lib/serverConfig";
import { QrModal } from "./QrModal";
import { ScanModal } from "./ScanModal";
import { PairModal } from "./PairModal";
import { TrashModal } from "./TrashModal";

export function ShellModals() {
  const store = useShell();
  const { t } = useT();
  const {
    qrFor, showQr, shareSite, setShareSite, scanOpen, setScanOpen,
    handleScanResult, pairOpen, setPairOpen, pairings, refreshPairings,
    trashOpen, setTrashOpen, fetchMine,
  } = store;
  // 每次渲染现取:设置里改/清服务器地址后,分享本站二维码要用最新地址(壳不重挂)
  const serverBase = getServerBase();

  return (
    <>
      {qrFor && (
        <QrModal
          url={buildJoinUrl(serverBase, qrFor)}
          title={t("qrModal.title")}
          desc={t("qrModal.desc")}
          onClose={() => showQr(null)}
        />
      )}
      {shareSite && (
        <QrModal url={serverBase} title={t("qrModal.siteTitle")} onClose={() => setShareSite(false)} />
      )}
      {scanOpen && <ScanModal onResult={handleScanResult} onClose={() => setScanOpen(false)} />}
      {pairOpen && (
        <PairModal pairings={pairings} refresh={refreshPairings} onClose={() => setPairOpen(false)} />
      )}
      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} onChanged={() => void fetchMine()} />}
    </>
  );
}

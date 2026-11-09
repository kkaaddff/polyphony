// 移动端编辑工具栏(参考小米笔记:编辑态才出现,悬浮在键盘上方的圆角胶囊)。
// 它作为 toolbarPlugin 的内容渲染在 MDXEditor realm 里(才能读写编辑器状态),
// 再经 portal 挂到 MobileDocView 底部的槽位——位置由页面布局决定,不在编辑器顶部。
// 同时把当前 Lexical 编辑器与撤销/重做可用性交给页面,供顶栏的 撤销/重做 按钮使用。
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  activeEditor$,
  applyFormat$,
  applyListType$,
  convertSelectionToNode$,
  currentBlockType$,
  currentFormat$,
  currentListType$,
  openNewImageDialog$,
  useCellValues,
  usePublisher,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
} from "@mdxeditor/editor";
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import {
  $createParagraphNode,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  type LexicalEditor,
  type TextFormatType,
} from "lexical";
import {
  BoldOutlined,
  CheckSquareOutlined,
  CodeOutlined,
  FontSizeOutlined,
  ItalicOutlined,
  OrderedListOutlined,
  PictureOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { useT, type TKey } from "@/i18n";

export type HistoryState = { canUndo: boolean; canRedo: boolean };

interface BridgeValue {
  /** 工具栏 portal 目标(页面底部槽位);null 时不渲染 */
  slot: HTMLElement | null;
  onEditor: (editor: LexicalEditor | null) => void;
  onHistory: (h: HistoryState) => void;
}

const BridgeContext = createContext<BridgeValue | null>(null);

/** 页面侧:包住 MDXEditor,提供槽位与回调。 */
export function MobileEditorBridge({ value, children }: { value: BridgeValue; children: ReactNode }) {
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

/** 编辑器侧:toolbarContents 渲染它。 */
export function MobileToolbarPortal() {
  const bridge = useContext(BridgeContext);
  const [activeEditor] = useCellValues(activeEditor$);
  const onEditor = bridge?.onEditor;
  const onHistory = bridge?.onHistory;

  useEffect(() => {
    onEditor?.(activeEditor);
    if (!activeEditor || !onHistory) return;
    let canUndo = false;
    let canRedo = false;
    const offUndo = activeEditor.registerCommand(
      CAN_UNDO_COMMAND,
      (v) => {
        canUndo = v;
        onHistory({ canUndo, canRedo });
        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );
    const offRedo = activeEditor.registerCommand(
      CAN_REDO_COMMAND,
      (v) => {
        canRedo = v;
        onHistory({ canUndo, canRedo });
        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );
    return () => {
      offUndo();
      offRedo();
    };
  }, [activeEditor, onEditor, onHistory]);

  if (!bridge?.slot) return null;
  return createPortal(<MobileToolbar />, bridge.slot);
}

// pointerdown 阻止默认:点工具栏不夺走正文焦点(否则键盘收起、选区丢失)
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

function ToolButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={`flex-1 min-w-tap-44 min-h-tap-44 flex items-center justify-center rounded-xl text-xl transition-colors ${
        active ? "text-accent bg-accent/10" : "text-gray-800 active:bg-gray-100"
      }`}
    >
      {children}
    </button>
  );
}

const BLOCKS: { type: "h1" | "h2" | "h3" | "paragraph" | "quote"; label: TKey; cls: string }[] = [
  { type: "h1", label: "mobile.heading1", cls: "text-lg font-bold" },
  { type: "h2", label: "mobile.heading2", cls: "text-base font-bold" },
  { type: "h3", label: "mobile.heading3", cls: "text-sm font-semibold" },
  { type: "paragraph", label: "mobile.body", cls: "text-sm" },
  { type: "quote", label: "mobile.quote", cls: "text-sm italic" },
];

const FORMATS: { fmt: TextFormatType; bit: number; label: TKey; icon: ReactNode }[] = [
  { fmt: "bold", bit: IS_BOLD, label: "mobile.bold", icon: <BoldOutlined /> },
  { fmt: "italic", bit: IS_ITALIC, label: "mobile.italic", icon: <ItalicOutlined /> },
  { fmt: "underline", bit: IS_UNDERLINE, label: "mobile.underline", icon: <UnderlineOutlined /> },
  { fmt: "strikethrough", bit: IS_STRIKETHROUGH, label: "mobile.strike", icon: <StrikethroughOutlined /> },
  { fmt: "code", bit: IS_CODE, label: "mobile.inlineCode", icon: <CodeOutlined /> },
];

function MobileToolbar() {
  const { t } = useT();
  const [blockType, format, listType] = useCellValues(currentBlockType$, currentFormat$, currentListType$);
  const applyFormat = usePublisher(applyFormat$);
  const applyListType = usePublisher(applyListType$);
  const convertSelectionToNode = usePublisher(convertSelectionToNode$);
  const openImageDialog = usePublisher(openNewImageDialog$);
  const [formatOpen, setFormatOpen] = useState(false);

  const setBlock = (type: (typeof BLOCKS)[number]["type"]) => {
    if (type === "paragraph") convertSelectionToNode(() => $createParagraphNode());
    else if (type === "quote") convertSelectionToNode(() => $createQuoteNode());
    else convertSelectionToNode(() => $createHeadingNode(type as HeadingTagType));
  };
  // 再点一次同类列表 = 取消列表(与桌面 ListsToggle 行为一致)
  const toggleList = (type: "bullet" | "number" | "check") =>
    applyListType(listType === type ? "" : type);

  return (
    <div className="px-3 pb-2 space-y-2">
      {formatOpen && (
        <div
          className="rounded-2xl bg-white shadow-[0_4px_24px_rgba(0,0,0,0.12)] p-3 space-y-3"
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
        >
          <div className="flex gap-2 overflow-x-auto">
            {BLOCKS.map((b) => (
              <button
                key={b.type}
                type="button"
                onClick={() => setBlock(b.type)}
                aria-pressed={blockType === b.type}
                className={`shrink-0 px-3 min-h-tap-40 rounded-xl ${b.cls} ${
                  blockType === b.type ? "bg-accent/15 text-accent" : "bg-gray-100 text-gray-800"
                }`}
              >
                {t(b.label)}
              </button>
            ))}
          </div>
          <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
            {FORMATS.map((f) => (
              <ToolButton
                key={f.fmt}
                label={t(f.label)}
                active={(format & f.bit) !== 0}
                onClick={() => applyFormat(f.fmt)}
              >
                {f.icon}
              </ToolButton>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1 rounded-2xl bg-white shadow-[0_4px_24px_rgba(0,0,0,0.12)] px-2 py-1">
        <ToolButton label={t("mobile.checklist")} active={listType === "check"} onClick={() => toggleList("check")}>
          <CheckSquareOutlined />
        </ToolButton>
        <ToolButton label={t("mobile.bullet")} active={listType === "bullet"} onClick={() => toggleList("bullet")}>
          <UnorderedListOutlined />
        </ToolButton>
        <ToolButton label={t("mobile.numbered")} active={listType === "number"} onClick={() => toggleList("number")}>
          <OrderedListOutlined />
        </ToolButton>
        <ToolButton label={t("mobile.image")} onClick={() => openImageDialog()}>
          <PictureOutlined />
        </ToolButton>
        <ToolButton label={t("mobile.textFormat")} active={formatOpen} onClick={() => setFormatOpen((v) => !v)}>
          <FontSizeOutlined />
        </ToolButton>
      </div>
    </div>
  );
}

// 编辑器插件装配。工厂形式：imageUploadHandler 引用变化时才重建插件数组，
// 页面里用 useMemo 持有——避免每次 render 都新建一整套插件实例。
import {
  headingsPlugin,
  listsPlugin,
  linkPlugin,
  linkDialogPlugin,
  quotePlugin,
  tablePlugin,
  codeBlockPlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  thematicBreakPlugin,
  frontmatterPlugin,
  imagePlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  InsertTable,
  InsertImage,
  InsertCodeBlock,
  InsertFrontmatter,
  InsertThematicBreak,
  CodeToggle,
  CreateLink,
  ListsToggle,
  BlockTypeSelect,
} from "@mdxeditor/editor";
import { MobileToolbarPortal } from "@/components/mobile/MobileEditorToolbar";

function contentPlugins(
  imageUploadHandler: (image: File) => Promise<string>,
  imagePreviewHandler?: (src: string) => Promise<string>
) {
  return [
    headingsPlugin(),
    listsPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    quotePlugin(),
    tablePlugin(),
    codeBlockPlugin(),
    thematicBreakPlugin(),
    frontmatterPlugin(),
    imagePlugin({ imageUploadHandler, imagePreviewHandler: imagePreviewHandler ?? null }),
    markdownShortcutPlugin(),
  ];
}

export function createEditorPlugins(
  imageUploadHandler: (image: File) => Promise<string>,
  imagePreviewHandler?: (src: string) => Promise<string>
) {
  return [
    ...contentPlugins(imageUploadHandler, imagePreviewHandler),
    toolbarPlugin({
      toolbarContents: () => (
        <>
          <UndoRedo />
          <BoldItalicUnderlineToggles />
          <BlockTypeSelect />
          <InsertTable />
          <InsertImage />
          <InsertCodeBlock />
          <InsertFrontmatter />
          <InsertThematicBreak />
          <CodeToggle />
          <CreateLink />
          <ListsToggle />
        </>
      ),
    }),
  ];
}

/**
 * 移动端:内容能力与桌面一致,工具栏换成 MobileToolbarPortal(portal 到页面底部槽位,
 * 须在 MobileEditorBridge 内使用)。编辑器自带的顶部工具栏容器留空并隐藏。
 */
export function createMobileEditorPlugins(
  imageUploadHandler: (image: File) => Promise<string>,
  imagePreviewHandler?: (src: string) => Promise<string>
) {
  return [
    ...contentPlugins(imageUploadHandler, imagePreviewHandler),
    toolbarPlugin({
      toolbarClassName: "!hidden",
      toolbarContents: () => <MobileToolbarPortal />,
    }),
  ];
}

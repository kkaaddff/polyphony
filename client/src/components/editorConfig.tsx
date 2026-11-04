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

export function createEditorPlugins(
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

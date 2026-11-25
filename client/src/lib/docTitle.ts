// 文档在列表/确认框里的显示标题:共享名 > 正文开头(服务端 /rooms 的 preview) > 「未命名文档」。
// 只用于展示:标题输入框仍以空名为准(placeholder 提示未命名),不会把正文写回文档名。
export function docTitle(doc: { name?: string; preview?: string }, unnamed: string): string {
  return doc.name?.trim() || doc.preview?.trim() || unnamed;
}

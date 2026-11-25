// 修复 @mdxeditor/editor 表格「能粘贴进、拷贝不出」的 bug。
//
// 根因：tablePlugin 的 TableNode 是 Lexical 的 DecoratorNode，其 createDOM 只返回一个空
// <div>，真正的表格 DOM 由 decorate() 的 React 组件渲染；而 TableNode 没有实现 exportDOM()。
// Lexical 内建的拷贝靠 $generateHtmlFromNodes() 逐节点调用 exportDOM() 生成 text/html，
// 对 TableNode 只会产出默认的空 <span>；DecoratorNode 又没有文本，text/plain 也为空。
// 结果：选中表格 Ctrl+C，剪贴板里关于表格什么都没有 → 粘贴哪儿都没东西。
// 反向能粘贴进：外部 Excel/网页/Word 的表格带真实 <table> HTML，importDOM('table') 命中。
//
// 修复：在客户端给 TableNode.prototype 补一个 exportDOM()，把内部 mdast 表格渲染成真正的
// <table> 元素。仅剪贴板/HTML 序列化路径会调用 exportDOM，不影响 markdown 导出（走 mdast）
// 与日常编辑。导入即生效（idempotent）。

import { TableNode } from "@mdxeditor/editor";

type MdastNode = {
  type?: string;
  value?: string;
  url?: string;
  alt?: string;
  title?: string;
  align?: (string | null)[] | null;
  children?: MdastNode[];
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/"/g, "&quot;");
}

// mdast 行内节点 → HTML 片段（覆盖表格单元里常见的内联类型）
function inlineToHtml(nodes?: MdastNode[]): string {
  if (!Array.isArray(nodes)) return "";
  return nodes
    .map((n) => {
      if (!n) return "";
      switch (n.type) {
        case "text":
          return escapeHtml(n.value ?? "");
        case "strong":
          return `<strong>${inlineToHtml(n.children)}</strong>`;
        case "emphasis":
          return `<em>${inlineToHtml(n.children)}</em>`;
        case "delete":
        case "strikethrough":
          return `<del>${inlineToHtml(n.children)}</del>`;
        case "inlineCode":
          return `<code>${escapeHtml(n.value ?? "")}</code>`;
        case "break":
          return "<br />";
        case "link":
          return `<a href="${escapeAttr(n.url ?? "")}"${
            n.title ? ` title="${escapeAttr(n.title ?? "")}"` : ""
          }>${inlineToHtml(n.children)}</a>`;
        case "image":
          return `<img src="${escapeAttr(n.url ?? "")}" alt="${escapeAttr(
            n.alt ?? ""
          )}" />`;
        case "html":
          return n.value ?? "";
        default:
          // 其余容器/未知行内节点：递归取 children，尽量不丢内容
          return inlineToHtml(n.children);
      }
    })
    .join("");
}

function mdastTableToHtml(table: MdastNode): HTMLTableElement {
  const el = document.createElement("table");
  const rows = table.children ?? [];
  const align = Array.isArray(table.align) ? table.align : null;
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    const cells = row.children ?? [];
    cells.forEach((cell, colIndex) => {
      // GFM 表格首行为表头
      const cellEl = document.createElement(rowIndex === 0 ? "th" : "td");
      cellEl.innerHTML = inlineToHtml(cell.children);
      if (align && align[colIndex]) {
        cellEl.style.textAlign = align[colIndex] as string;
      }
      tr.appendChild(cellEl);
    });
    el.appendChild(tr);
  });
  return el;
}

if (typeof window !== "undefined") {
  const proto = TableNode.prototype as unknown as {
    __mdastNode?: MdastNode;
    __mdxTableCopyPatched?: boolean;
    exportDOM?: (this: { __mdastNode?: MdastNode }) => {
      element: HTMLElement;
    };
  };
  // idempotent：HMR/重复 import 不重复打补丁
  if (!proto.__mdxTableCopyPatched) {
    // 覆盖 DecoratorNode 默认的空 exportDOM，让 Lexical 拷贝时产出真实 <table>
    proto.exportDOM = function exportDOM(this: { __mdastNode?: MdastNode }) {
      const table = this.__mdastNode ?? { type: "table", children: [] };
      return { element: mdastTableToHtml(table) };
    };
    proto.__mdxTableCopyPatched = true;
  }
}

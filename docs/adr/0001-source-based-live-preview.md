# 编辑器以源码为唯一真相，在 CodeMirror 6 上做实时预览

MINT 不采用 Typora 式的文档树所见即所得（ProseMirror / Milkdown / Tiptap），而是以 Markdown 源码为唯一真相：编辑器内核是 CodeMirror 6，通过装饰实现片段显露，并用块组件替换表格、公式、图表等块。这样源码保真自然成立，中文输入法在 WebKit 上稳定，大文件也能靠视口渲染保持流畅，还能直接修改被隐藏的标记。

## Considered Options

- **文档树 WYSIWYG（ProseMirror 系）**：最像 Typora，从网页粘贴富文本也最顺；但存盘时要从树重新序列化，往返有损，WebKit 下中文 IME 问题多，大文档性能差。
- **按行显露的实时预览（Obsidian 式）**：实现简单，但光标所在整行变回源码，跳动明显。
- **左右分栏**：体验上明显落后于目标。

## Consequences

- 可编辑的表格块组件要自己做，这是主要工作量之一。
- 从网页粘贴富文本需要显式做 HTML → Markdown 转换。
- 编辑态由 Lezer 增量解析；导出管线另用 unified/remark，两者需要在方言上保持一致。

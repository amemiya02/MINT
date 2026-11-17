# MINT

MINT (MINT Is Not Typora) 是一个开源、跨平台、轻量的桌面 Markdown 编辑器：直接编辑磁盘上的 `.md` 文件，所见即所得，同时保证源码不被篡改。

## Language

### 编辑体验

**实时预览 (Live Preview)**:
MINT 的默认编辑模式：编辑的始终是 Markdown 源码本身，但源码被就地渲染成排版后的样子。
_Avoid_: 所见即所得模式, WYSIWYG 模式, 富文本模式

**源码模式 (Source Mode)**:
关闭所有渲染、直接显示原始 Markdown 文本的编辑模式；与实时预览编辑的是同一份内容。
_Avoid_: 纯文本模式, 代码模式

**片段显露 (Span Reveal)**:
实时预览中，光标触及某个行内片段（如粗体、链接）时，仅该片段的 Markdown 标记变为可见；其余内容保持渲染。
_Avoid_: 行显露, 展开源码

**块组件 (Block Widget)**:
实时预览中替代整个 Markdown 块显示的交互式视图，如表格、数学公式、图表、图片、代码块、Front Matter。
_Avoid_: 块渲染, 嵌入块

**源码保真 (Source Fidelity)**:
MINT 对文件的承诺：用户未编辑的部分在保存后与原文件逐字节相同。
_Avoid_: 无损, 往返一致

**扩展语法 (Extended Syntax)**:
不属于 CommonMark/GFM、也不被 GitHub 等主流平台渲染的 Markdown 写法（如 `[TOC]`、`==高亮==`、`^上标^`、`~下标~`）；在 MINT 中默认关闭。
_Avoid_: Typora 语法, 私有语法

**大纲 (Outline)**:
由文档标题层级生成的目录视图，用于在文档内导航。
_Avoid_: 目录, TOC（`[TOC]` 专指扩展语法中的目录标记）

**专注模式 (Focus Mode)**:
只突出当前编辑段落、淡化其余内容的显示方式。

**打字机模式 (Typewriter Mode)**:
让光标所在行始终保持在窗口垂直中部的滚动方式。

**命令面板 (Command Palette)**:
按名称搜索并执行 MINT 中任意命令的弹出面板。

**编辑器内核 (Editor Core)**:
与外壳界面和平台无关、独立成包的实时预览编辑器本体。
_Avoid_: 编辑器组件, 引擎

**主题 (Theme)**:
一份基于 MINT 的 CSS 变量体系、决定编辑器与界面外观的样式表。
_Avoid_: 皮肤, 样式

### 文件

**资源目录 (Asset Folder)**:
粘贴或拖入的图片等附件被复制到的目录，文档以相对路径引用其中的文件。
_Avoid_: 图片文件夹, 附件目录

**标签页 (Tab)**:
窗口中一个已打开的文档的视图；一个窗口可容纳多个标签页。
_Avoid_: 页签, 缓冲区


**文档 (Document)**:
磁盘上的一个 Markdown 文件，也是 MINT 编辑的基本单位。
_Avoid_: 笔记, 页面

**工作文件夹 (Folder)**:
用户在 MINT 中打开的任意磁盘目录，用于在侧边栏浏览其中的文档；MINT 不在其中写入私有数据。
_Avoid_: 库, Vault, 工作区, 项目

# 编写 MINT 主题

**主题**是一份 `.css` 文件，它覆盖 MINT 的 CSS 变量，必要时也可以覆盖选择器。MINT 不兼容 Typora 主题（见 ADR-0003）。

## 内置主题

在「设置 → 主题」中选择。每套主题都支持亮色和暗色，可跟随系统，也可在「亮暗模式」中手动指定。

| 主题 | 风格 | `settings.json` 中的 `theme` 值 |
| --- | --- | --- |
| 青苔（Sage） | 鼠尾草绿、无衬线正文和衬线标题，适合日常笔记 | `"builtin/sage"` |
| 书页（Bookleaf） | 暖纸色、衬线正文和陶土色强调，适合长文 | `"builtin/bookleaf"` |
| 蓝图（Blueprint） | 蓝灰底色、等宽标题，适合技术文档 | `"builtin/blueprint"` |
| 暮色（Dusk） | 淡紫亮色和深紫灰暗色，适合夜间写作 | `"builtin/dusk"` |

### Typora 参考主题

「Typora 经典风格」收录 Typora 自带的六套主题。「Typora 社区风格」选取十四套有代表性的社区主题。下列主题均使用 MINT 的 CSS 变量和编辑器选择器重新编写，随应用提供；原作仅提供单一亮暗外观时，另一套配色由 MINT 补齐。

| 主题 | 风格 | `settings.json` 中的 `theme` 值 | 参考来源 |
| --- | --- | --- | --- |
| GitHub（默认） | 蓝色链接、灰底代码和带分隔线的标题 | `""` 或 `"builtin/github"` | [官方样式](https://github.com/typora/typora-default-themes) |
| Gothic | 几何无衬线字、居中标题和酒红色链接 | `"builtin/gothic"` | [官方样式](https://github.com/typora/typora-default-themes) |
| Newsprint | 暖灰纸色、报刊衬线字和刊头细线 | `"builtin/newsprint"` | [官方样式](https://github.com/typora/typora-default-themes) |
| Night | 石板灰底、浅蓝强调和轻字重标题 | `"builtin/night"` | [官方样式](https://github.com/typora/typora-default-themes) |
| Pixyll | 衬线正文配大号无衬线标题 | `"builtin/pixyll"` | [官方样式](https://github.com/typora/typora-default-themes) |
| Whitey | 简洁纸面、居中衬线标题和短横线 | `"builtin/whitey"` | [官方样式](https://github.com/typora/typora-default-themes) |
| Academic | 黑墨色衬线正文和居中论文标题 | `"builtin/academic"` | [原主题](https://theme.typora.io/theme/Academic/) |
| Cobalt | 深海蓝与琥珀色强调 | `"builtin/cobalt"` | [原主题](https://github.com/elitistsnob/typora-cobalt-theme) |
| Dracula | 紫灰底色、粉色代码和青色链接 | `"builtin/dracula"` | [原主题](https://github.com/dracula/typora) |
| Drake | 扁平界面，亮色用珊瑚红，暗色用蓝色 | `"builtin/drake"` | [原主题](https://theme.typora.io/theme/Drake/) |
| GitBook | 文档手册式标题和蓝色链接 | `"builtin/gitbook"` | [原主题](https://github.com/h16nning/typora-gitbook-theme) |
| Ladder | 石板色与天蓝色，优先使用本机霞鹜文楷 | `"builtin/ladder"` | [原主题](https://github.com/guangzhengli/typora-ladder-theme) |
| Lapis | 墨蓝色文字和浅色底纹小标题 | `"builtin/lapis"` | [原主题](https://github.com/YiNNx/typora-theme-lapis) |
| Mdmdt | 中性文档底色、蓝色细节和内嵌引文 | `"builtin/mdmdt"` | [原主题](https://github.com/cayxc/Mdmdt) |
| Notion | 暖灰界面、紧凑标题和红色行内代码 | `"builtin/notion"` | [原主题](https://github.com/adrian-fuertes/typora-notion-theme) |
| Pie | 珊瑚红标题和 Palenight 风格的代码配色 | `"builtin/pie"` | [原主题](https://theme.typora.io/theme/Pie/) |
| Purple | 紫色衬线标题、青色链接和淡紫代码背景 | `"builtin/purple"` | [原主题](https://theme.typora.io/theme/Purple/) |
| Typora LaTeX | 仿 LaTeX 的论文排版 | `"builtin/typora-latex"` | [原主题](https://theme.typora.io/theme/LaTeX-Typora/) |
| Ursine | 浅色玫红、暗色天蓝，搭配石墨灰 | `"builtin/ursine"` | [原主题](https://github.com/noatpad/typora-theme-ursine) |
| Vue | 石板色标题和绿色引用块 | `"builtin/vue"` | [原主题](https://theme.typora.io/theme/Vue/) |

## 安装自定义主题

1. 把 `名字.css` 放进主题目录。设置窗口的「主题」一项下方会显示这个目录的完整路径，它位于 MINT 的应用数据目录中，名为 `themes`。
2. 在设置窗口的「主题」中选择它，或者在 `settings.json` 中写 `"theme": "名字"`。
3. 主题目录处于监听状态。新增、修改或删除主题文件后，界面会立即更新，不需要重启。

如果选中的主题文件不存在或无法读取，MINT 会提示原因，并在问题解决前使用默认主题。

## 亮色与暗色

MINT 会在 `<html>` 上设置 `data-appearance="light"` 或 `data-appearance="dark"`。这个值由设置中的「亮暗模式」决定：选择「跟随系统」时随系统切换，也可以手动固定为亮色或暗色。主题用这个属性分别给出两套颜色：

```css
:root {
  --mint-bg: #fbf8f1;
  --mint-fg: #2b2a28;
}

:root[data-appearance="dark"] {
  --mint-bg: #1d1c1a;
  --mint-fg: #e8e4dc;
}
```

基础样式的规则写在 `:where()` 中，优先级为零，所以主题中普通的 `:root { … }` 可以覆盖它们。主题没有设置的变量会沿用当前亮暗模式下的基础值。如果主题只写了 `:root`，它在暗色模式下也会生效。

## 设置优先于主题

用户在设置中指定的字体、字号、行高和内容宽度会以内联样式写到 `<html>` 上，因此总是覆盖主题中的 `--mint-font-editor`、`--mint-font-size`、`--mint-line-height` 和 `--mint-content-width`。字体设置为空时，使用主题的字体。

## 变量清单

下表列出全部变量及其基础亮色值。只覆盖需要修改的变量即可。

### 排版

| 变量 | 作用 | 基础值 |
| --- | --- | --- |
| `--mint-font-ui` | 界面文字（侧边栏、标签页、对话框）的字体 | 系统界面字体 |
| `--mint-font-editor` | 文档正文的字体（可被「字体」设置覆盖） | 等宽字体 |
| `--mint-font-code` | 行内代码和代码的字体 | 等宽字体 |
| `--mint-font-heading` | 标题的字体 | `inherit`（同正文） |
| `--mint-font-size` | 文档正文字号（可被「字号」设置覆盖） | `15px` |
| `--mint-line-height` | 文档正文行高（可被「行高」设置覆盖） | `1.7` |
| `--mint-content-width` | 文档正文的最大宽度（可被「内容宽度」设置覆盖） | `740px` |

### 界面

| 变量 | 作用 | 基础值 |
| --- | --- | --- |
| `--mint-bg` | 窗口和文档的背景色 | `#fdfdfc` |
| `--mint-fg` | 主要文字颜色 | `#1f2328` |
| `--mint-muted` | 次要文字颜色（提示、路径、状态） | `#6b717a` |
| `--mint-border` | 分隔线和边框 | `#e3e5e8` |
| `--mint-hover` | 鼠标悬停时的背景 | `#f1f2f4` |
| `--mint-selected` | 选中项（当前标签页、文件树中的当前文档）的背景 | `#e3efec` |
| `--mint-sidebar-bg` | 侧边栏背景 | `#f7f7f6` |
| `--mint-accent` | 强调色：焦点框、复选框等 | `#2f7d6d` |
| `--mint-error-bg` | 错误和警告提示条的背景 | `#fdecea` |
| `--mint-error-fg` | 错误和警告提示条的文字 | `#a1260d` |
| `--mint-notice-bg` | 提示条（如更新、外部修改提示）的背景 | `#fdf6e3` |
| `--mint-notice-fg` | 提示条的文字 | `#6f4e00` |
| `--mint-diff-removed-bg` | 冲突对比中被删除内容的背景 | `#fbe4e2` |
| `--mint-diff-added-bg` | 冲突对比中新增内容的背景 | `#ddf4e4` |

### 文档

| 变量 | 作用 | 基础值 |
| --- | --- | --- |
| `--mint-caret` | 光标颜色 | `#1f2328` |
| `--mint-selection` | 选区背景 | `#cfe5df` |
| `--mint-heading-fg` | 标题文字颜色 | `#14171a` |
| `--mint-heading-weight` | 标题字重 | `650` |
| `--mint-heading-1-size`、`--mint-heading-2-size`、`--mint-heading-3-size`、`--mint-heading-4-size`、`--mint-heading-5-size`、`--mint-heading-6-size` | 一到六级标题的字号，相对正文 | `1.75em`、`1.5em`、`1.3em`、`1.15em`、`1em`、`0.95em` |
| `--mint-strong-fg` | 粗体文字颜色 | `inherit` |
| `--mint-emphasis-fg` | 斜体文字颜色 | `inherit` |
| `--mint-link` | 链接文字颜色 | `#2f7d6d` |
| `--mint-code-fg` | 行内代码文字颜色 | `#3b4048` |
| `--mint-code-bg` | 实时预览中行内代码的背景 | `#eff1f3` |
| `--mint-quote-fg` | 引用块文字颜色 | `#5b616a` |
| `--mint-highlight-bg` | 实时预览中 `==高亮==`（扩展语法）的背景 | `#fff0a6` |
| `--mint-marker` | Markdown 标记（`#`、`**`、`>` 等）在显示时的颜色 | `#8a9099` |
| `--mint-find-match` | 查找时所有匹配项的背景 | `#ffe58a99` |
| `--mint-find-current` | 查找时当前匹配项的背景 | `#ffb84d` |
| `--mint-focus-dimmed-opacity` | 专注模式下当前段落以外内容的不透明度 | `0.35` |

基础暗色值见 `apps/desktop/src/theme/builtin.css`。青苔的亮暗配色见 `apps/desktop/src/theme/sage.css`。

## 可覆盖的选择器

变量不够用时，可以直接为这些类名写样式。它们属于主题约定，修改前会在更新说明中注明。

| 类名 | 标记的内容 |
| --- | --- |
| `.cm-mint-heading`，`.cm-mint-heading-1` … `.cm-mint-heading-6` | 标题（包括它的 `#` 标记） |
| `.cm-mint-quote` | 引用块 |
| `.cm-mint-md-emphasis`，`.cm-mint-md-strong`，`.cm-mint-md-strikethrough` | 斜体、粗体、删除线（两种编辑模式下都有） |
| `.cm-mint-md-link`，`.cm-mint-md-url` | 链接文字、链接地址 |
| `.cm-mint-md-code` | 行内代码 |
| `.cm-mint-md-mark`，`.cm-mint-md-rule` | Markdown 标记、分隔线 |
| `.cm-mint-strong`，`.cm-mint-emphasis`，`.cm-mint-strikethrough`，`.cm-mint-superscript`，`.cm-mint-subscript`，`.cm-mint-highlight` | 实时预览中渲染后的粗体、斜体、删除线、上标、下标、高亮 |
| `.cm-mint-toc`，`.cm-mint-toc-entry` | 实时预览中 `[TOC]` 渲染成的目录及其中的每一项 |
| `.cm-mint-code`，`.cm-mint-link` | 实时预览中渲染后的行内代码、链接文字 |
| `.cm-mint-marker` | 实时预览中因片段显露而可见的 Markdown 标记 |
| `.mint-find-match`，`.mint-find-match-current` | 查找匹配项、当前匹配项 |
| `.cm-mint-focus-mode`，`.cm-mint-focused` | 开启专注模式的编辑器；专注模式下当前段落的各行 |
| `.cm-mint-typewriter-mode` | 开启打字机模式的编辑器 |
| `.mint-editor .cm-content` | 文档正文区域 |

编辑区是 CodeMirror 6 的 DOM。除上表外的 `.cm-*` 类名属于实现细节，可能随版本变化。

## 导出的文档

导出 HTML 或 PDF 时可以选择任意内置或自定义主题，并为导出文件指定亮暗模式。MINT 把基础样式、所选主题和字体设置一起内联到导出 HTML 中，并在 `<html>` 上设置所选的 `data-appearance`。导出文件中的正文是普通的 HTML 元素（`h1`、`p`、`pre`、`table` 等），包在 `.mint-document` 中，样式同样由上面的变量决定，所以只覆盖变量的主题在编辑器和导出文件中效果一致。主题中针对编辑器 DOM（`.cm-*`）的选择器不会作用于导出文件；如果想单独调整导出效果，可以为 `.mint-document` 及其中的元素写样式。

代码块中的语法高亮在两处使用相同的类名：`.cm-mint-code-keyword`、`.cm-mint-code-string`、`.cm-mint-code-number`、`.cm-mint-code-comment`、`.cm-mint-code-name`。Mermaid 图表以 SVG 形式放在 `figure.mint-mermaid` 中。

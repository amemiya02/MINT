# 编写 MINT 主题

**主题**是一份 `.css` 文件，它覆盖 MINT 的 CSS 变量，必要时也可以覆盖选择器。MINT 不兼容 Typora 主题（见 ADR-0003）。

## 安装与切换

1. 把 `名字.css` 放进主题目录。设置窗口的「主题」一项下方会显示这个目录的完整路径，它位于 MINT 的应用数据目录中，名为 `themes`。
2. 在设置窗口的「主题」中选择它，或者在 `settings.json` 中写 `"theme": "名字"`。值为 `""` 时使用内置主题。
3. 主题目录处于监听状态。新增、修改或删除主题文件后，界面会立即更新，不需要重启。

如果选中的主题文件不存在或无法读取，MINT 会提示原因，并在问题解决前使用内置主题。

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

内置主题的规则写在 `:where()` 中，优先级为零，所以主题中普通的 `:root { … }` 一定能覆盖它们。主题没有设置的变量会沿用内置主题在当前亮暗模式下的值。如果主题只写了 `:root`，它在暗色模式下也会生效。

## 设置优先于主题

用户在设置中指定的字体、字号、行高和内容宽度会以内联样式写到 `<html>` 上，因此总是覆盖主题中的 `--mint-font-editor`、`--mint-font-size`、`--mint-line-height` 和 `--mint-content-width`。字体设置为空时，使用主题的字体。

## 变量清单

下表列出全部变量及其在内置亮色主题中的值。只覆盖需要修改的变量即可。

### 排版

| 变量 | 作用 | 内置值 |
| --- | --- | --- |
| `--mint-font-ui` | 界面文字（侧边栏、标签页、对话框）的字体 | 系统界面字体 |
| `--mint-font-editor` | 文档正文的字体（可被「字体」设置覆盖） | 等宽字体 |
| `--mint-font-code` | 行内代码和代码的字体 | 等宽字体 |
| `--mint-font-heading` | 标题的字体 | `inherit`（同正文） |
| `--mint-font-size` | 文档正文字号（可被「字号」设置覆盖） | `15px` |
| `--mint-line-height` | 文档正文行高（可被「行高」设置覆盖） | `1.7` |
| `--mint-content-width` | 文档正文的最大宽度（可被「内容宽度」设置覆盖） | `740px` |

### 界面

| 变量 | 作用 | 内置值 |
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

### 文档

| 变量 | 作用 | 内置值 |
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
| `--mint-marker` | Markdown 标记（`#`、`**`、`>` 等）在显示时的颜色 | `#8a9099` |
| `--mint-find-match` | 查找时所有匹配项的背景 | `#ffe58a99` |
| `--mint-find-current` | 查找时当前匹配项的背景 | `#ffb84d` |

暗色主题的取值见 `apps/desktop/src/theme/builtin.css`。

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
| `.mint-find-match`，`.mint-find-match-current` | 查找匹配项、当前匹配项 |
| `.mint-editor .cm-content` | 文档正文区域 |

编辑区是 CodeMirror 6 的 DOM。除上表外的 `.cm-*` 类名属于实现细节，可能随版本变化。

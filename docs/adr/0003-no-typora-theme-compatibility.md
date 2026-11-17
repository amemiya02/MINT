# 不兼容 Typora 主题，自建 CSS 变量主题体系

Typora 主题是针对它自己的 DOM 结构写的 CSS，而 MINT 的编辑区是 CodeMirror 6 的 DOM（见 ADR-0001），两者结构完全不同，做兼容层的成本高，而且会把 MINT 的 DOM 锁死在模仿 Typora 上。因此 MINT 自建主题体系：主题就是一份覆盖 MINT CSS 变量（必要时也覆盖选择器）的 `.css` 文件，放进主题目录即可生效。内置亮色和暗色两套主题，并跟随系统切换。

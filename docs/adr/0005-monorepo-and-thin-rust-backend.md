# 用 monorepo 拆出平台无关的编辑器内核，Rust 后端保持精简

仓库用 pnpm workspace 管理，分为三个包：`apps/desktop`（Tauri 应用，含 React 外壳和 Rust 后端）、`packages/editor`（编辑器内核，基于 CodeMirror 6，不依赖任何框架或平台）、`packages/markdown`（方言定义和 unified/remark 导出管线）。方言配置只在一处定义，编辑态和导出都从这里读取，以免两边渲染结果不一致。

Rust 后端只承担前端做不了或做不好的事：原子写盘、文件监听、基于 ripgrep crate 的全局搜索、窗口与菜单、设置读写。其他逻辑都写在 TypeScript 里，这样编辑器内核将来可以不经改动地放到移动端或 Web 上运行（见 ADR-0002）。

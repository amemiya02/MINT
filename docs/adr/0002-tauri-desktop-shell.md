# 桌面外壳用 Tauri 2，首发只支持桌面三端

MINT 首发支持 macOS、Windows、Linux，用 Tauri 2（Rust 后端 + 系统 WebView）而不是 Electron，因为「轻量」是核心卖点：安装包和内存占用都要明显小于 Typora 这类 Electron 应用。代价是三个平台的渲染引擎不同（WebKit / WebView2 / WebKitGTK），输入法和排版需要逐平台测试。移动端和 Web 版暂不做，但编辑器内核保持与平台无关，以后再扩展。

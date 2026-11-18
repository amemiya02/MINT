# MINT

**MINT Is Not Typora.** 开源、跨平台、所见即所得的 Markdown 编辑器。

[English](README.md)

## 功能

- **实时预览**：边写边渲染，光标所在处显露 Markdown 源码以便编辑；一键切换源码模式。
- **源码保真**：直接编辑磁盘上的 `.md` 文件，未改动的部分逐字节原样保存。
- **丰富内容**：GFM 表格与任务列表、数学公式（KaTeX）、Mermaid 图表、Front Matter、脚注和内联 HTML。
- **文件夹与标签页**：文件树、快速打开、文件夹内搜索、多标签页与多窗口。
- **写作辅助**：大纲、专注模式、打字机模式、命令面板，默认快捷键与 Typora 一致且可自定义。
- **安心写作**：自动保存与崩溃恢复，粘贴图片自动存入资源目录，可导出 HTML 和 PDF。
- 支持亮色和暗色模式，提供[内置主题与自定义 CSS 主题](docs/themes.md)，界面提供简体中文和英文。

## 安装

在 [Releases](https://github.com/amemiya02/MINT/releases/latest) 下载对应系统的安装包：

| 系统 | 文件 |
|---|---|
| macOS（Apple 芯片 / Intel） | `MINT_<版本>_aarch64.dmg` / `MINT_<版本>_x64.dmg` |
| Windows | `MINT_<版本>_x64-setup.exe` |
| Linux | `.AppImage`、`.deb` 或 `.rpm` |

安装包暂未做代码签名：

- **macOS**：若提示“无法打开”或“已损坏”，运行 `xattr -dr com.apple.quarantine /Applications/MINT.app`。
- **Windows**：若 SmartScreen 拦截，点 **更多信息 › 仍要运行**。

有新版本时 MINT 会自动更新（`.deb` 和 `.rpm` 安装除外）。

## 从源码构建

需要 Node 24+、pnpm 10+、Rust 以及 [Tauri 依赖](https://tauri.app/start/prerequisites/)。

```sh
pnpm install
pnpm dev
```

项目结构和测试见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

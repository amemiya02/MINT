import type { Messages } from "./index.ts";

export const zhCN: Messages = {
  "app.name": "MINT",
  "window.title": "{name} — MINT",
  "window.titleUnsaved": "● {name} — MINT",

  "menu.app": "MINT",
  "menu.file": "文件",
  "menu.edit": "编辑",
  "menu.view": "显示",
  "menu.quit": "退出 MINT",
  "menu.cut": "剪切",
  "menu.copy": "拷贝",
  "menu.paste": "粘贴",
  "menu.selectAll": "全选",

  "command.file.open": "打开…",
  "command.file.save": "保存",
  "command.view.toggleSourceMode": "切换源码模式",

  "dialog.open.title": "打开文档",
  "dialog.filter.markdown": "Markdown",

  "welcome.title": "没有打开的文档",
  "welcome.body": "打开一个 Markdown 文档，开始写作。",
  "welcome.open": "打开文档…",

  "status.saved": "已保存",
  "status.unsaved": "有未保存的改动",
  "status.mode.livePreview": "实时预览",
  "status.mode.source": "源码模式",

  "error.open": "无法打开 {path}：{reason}",
  "error.save": "无法保存 {path}：{reason}",
};

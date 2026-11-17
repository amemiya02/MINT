import type { Messages } from "./index.ts";

export const zhCN: Messages = {
  "app.name": "MINT",
  "window.title": "{name} — MINT",
  "window.titleUnsaved": "● {name} — MINT",

  "menu.app": "MINT",
  "menu.file": "文件",
  "menu.edit": "编辑",
  "menu.window": "窗口",
  "menu.quit": "退出 MINT",
  "menu.cut": "剪切",
  "menu.copy": "拷贝",
  "menu.paste": "粘贴",
  "menu.selectAll": "全选",

  "command.file.open": "打开…",
  "command.file.save": "保存",
  "command.tab.close": "关闭标签页",
  "command.tab.next": "显示下一个标签页",
  "command.tab.previous": "显示上一个标签页",
  "command.window.new": "新建窗口",

  "dialog.open.title": "打开文档",
  "dialog.filter.markdown": "Markdown",

  "welcome.title": "没有打开的文档",
  "welcome.body": "打开一个 Markdown 文档，开始写作。",
  "welcome.open": "打开文档…",

  "status.saved": "已保存",
  "status.unsaved": "有未保存的改动",

  "error.open": "无法打开 {path}：{reason}",
  "error.save": "无法保存 {path}：{reason}",

  "tabs.label": "已打开的文档",
  "tabs.close": "关闭 {name}",

  "unsaved.title": "未保存的改动",
  "unsaved.message": "是否保存对 {name} 的改动？如果不保存，改动将会丢失。",
  "unsaved.save": "保存",
  "unsaved.discard": "不保存",
  "unsaved.cancel": "取消",
};

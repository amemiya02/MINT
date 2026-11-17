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

  "command.app.settings": "设置…",
  "command.app.checkForUpdates": "检查更新…",

  "update.available": "MINT {version} 已发布。",
  "update.install": "安装并重启",
  "update.later": "稍后",
  "update.installing": "正在安装 MINT {version}…完成后 MINT 会自动重启。",
  "update.upToDate": "MINT 已是最新版本。",
  "update.unavailable": "此 MINT 副本不支持自动更新。请从发布页面或包管理器获取新版本。",
  "update.checkFailed": "无法检查更新：{reason}",
  "update.installFailed": "无法安装 MINT {version}：{reason}",

  "settings.title": "设置",
  "settings.close": "关闭",
  "settings.storedIn": "保存在 {path}",
  "settings.openFile": "打开 settings.json",
  "settings.dismiss": "关闭提示",
  "settings.issue.unreadable": "settings.json 无法使用（{reason}），继续使用上一次的有效设置。",
  "settings.issue.invalidValue":
    "settings.json 中的“{key}”必须是{expected}，该项继续使用上一次的有效设置。",
  "settings.issue.unknownKey": "settings.json 中有未知的设置项“{key}”，已忽略。",
  "settings.issue.writeFailed": "无法保存 settings.json：{reason}",
  "settings.expected.oneOf": "以下之一：{values}",
  "settings.expected.toggle": " true 或 false ",
  "settings.expected.number": " {min} 到 {max} 之间的数字",

  "settings.language": "界面语言",
  "settings.language.system": "跟随系统",
  "settings.language.zh-CN": "简体中文",
  "settings.language.en": "English",
  "settings.checkForUpdates": "启动时检查更新",

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

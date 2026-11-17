/** English UI strings. This is the reference catalogue: every locale must provide the same keys. */
export const en = {
  "app.name": "MINT",
  "window.title": "{name} — MINT",
  "window.titleUnsaved": "● {name} — MINT",

  "menu.app": "MINT",
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.window": "Window",
  "menu.view": "View",
  "menu.quit": "Quit MINT",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",

  "command.file.open": "Open…",
  "command.file.save": "Save",
  "command.view.toggleSourceMode": "Toggle Source Mode",

  "command.tab.close": "Close Tab",
  "command.tab.next": "Show Next Tab",
  "command.tab.previous": "Show Previous Tab",
  "command.window.new": "New Window",

  "command.app.settings": "Settings…",

  "settings.title": "Settings",
  "settings.close": "Close",
  "settings.storedIn": "Stored in {path}",
  "settings.openFile": "Open settings.json",
  "settings.dismiss": "Dismiss",
  "settings.issue.unreadable":
    "settings.json could not be used ({reason}). The last valid settings are still in use.",
  "settings.issue.invalidValue":
    "“{key}” in settings.json must be {expected}. Its last valid value is still in use.",
  "settings.issue.unknownKey": "settings.json contains an unknown setting “{key}”; it is ignored.",
  "settings.issue.writeFailed": "Could not save settings.json: {reason}",
  "settings.expected.oneOf": "one of {values}",
  "settings.expected.toggle": "true or false",
  "settings.expected.number": "a number from {min} to {max}",

  // One block per setting (see settings/schema.ts).
  "settings.language": "Interface language",
  "settings.language.system": "Follow system",
  "settings.language.zh-CN": "简体中文",
  "settings.language.en": "English",

  "dialog.open.title": "Open Document",
  "dialog.filter.markdown": "Markdown",

  "welcome.title": "No document open",
  "welcome.body": "Open a Markdown document to start writing.",
  "welcome.open": "Open Document…",

  "status.saved": "Saved",
  "status.unsaved": "Unsaved changes",
  "status.mode.livePreview": "Live Preview",
  "status.mode.source": "Source Mode",

  "error.open": "Could not open {path}: {reason}",
  "error.save": "Could not save {path}: {reason}",

  "tabs.label": "Open documents",
  "tabs.close": "Close {name}",

  "unsaved.title": "Unsaved Changes",
  "unsaved.message":
    "Do you want to save the changes you made to {name}? Your changes will be lost if you don't save them.",
  "unsaved.save": "Save",
  "unsaved.discard": "Don't Save",
  "unsaved.cancel": "Cancel",
} as const;

/** English UI strings. This is the reference catalogue: every locale must provide the same keys. */
export const en = {
  "app.name": "MINT",
  "window.title": "{name} — MINT",
  "window.titleUnsaved": "● {name} — MINT",

  "menu.app": "MINT",
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.window": "Window",
  "menu.quit": "Quit MINT",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",

  "command.file.open": "Open…",
  "command.file.save": "Save",
  "command.file.openFolder": "Open Folder…",
  "command.view.toggleSidebar": "Toggle Sidebar",
  "command.tab.close": "Close Tab",
  "command.tab.next": "Show Next Tab",
  "command.tab.previous": "Show Previous Tab",
  "command.window.new": "New Window",

  "command.edit.find": "Find…",
  "command.edit.replace": "Replace…",

  "find.label": "Find",
  "find.replaceWith": "Replace with",
  "find.caseSensitive": "Match Case",
  "find.wholeWord": "Match Whole Word",
  "find.regexp": "Use Regular Expression",
  "find.previous": "Previous Match",
  "find.next": "Next Match",
  "find.close": "Close",
  "find.replace": "Replace",
  "find.replaceAll": "Replace All",
  "find.count": "{current} of {total}",
  "find.noResults": "No results",
  "find.invalid": "Invalid regular expression",

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
  "dialog.openFolder.title": "Open Folder",

  "welcome.title": "No document open",
  "welcome.body": "Open a Markdown document to start writing.",
  "welcome.open": "Open Document…",
  "welcome.openFolder": "Open Folder…",
  "welcome.recent": "Recent",

  "sidebar.label": "Sidebar",
  "sidebar.hide": "Hide Sidebar",
  "tree.newDocument": "New Document",
  "tree.newFolder": "New Folder",
  "tree.rename": "Rename",
  "tree.trash": "Move to Trash",
  "tree.name": "Name",
  "tree.untitledDocument": "Untitled",
  "tree.untitledFolder": "Untitled Folder",

  "status.saved": "Saved",
  "status.unsaved": "Unsaved changes",

  "error.open": "Could not open {path}: {reason}",
  "error.save": "Could not save {path}: {reason}",
  "error.openFolder": "Could not open the folder {path}: {reason}",
  "error.invalidName": "“{name}” is not a valid name",
  "error.create": "Could not create {name}: {reason}",
  "error.rename": "Could not rename to {name}: {reason}",
  "error.trash": "Could not move {name} to the trash: {reason}",

  "tabs.label": "Open documents",
  "tabs.close": "Close {name}",

  "unsaved.title": "Unsaved Changes",
  "unsaved.message":
    "Do you want to save the changes you made to {name}? Your changes will be lost if you don't save them.",
  "unsaved.save": "Save",
  "unsaved.discard": "Don't Save",
  "unsaved.cancel": "Cancel",

  "external.conflict": "{name} was changed by another program, and you have unsaved changes here.",
  "external.keepMine": "Keep My Changes",
  "external.loadDisk": "Load from Disk",
  "external.compare": "Compare",
  "external.compare.title": "Compare with Disk",
  "external.compare.legend":
    "Lines marked − are only in this tab; lines marked + are only in {name} on disk.",
  "external.compare.close": "Close",
  "external.missing":
    "{name} was deleted or moved by another program. Save to write it back to its old place.",
  "external.save": "Save",
  "external.dismiss": "Dismiss",
} as const;

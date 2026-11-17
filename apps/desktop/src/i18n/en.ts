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
} as const;

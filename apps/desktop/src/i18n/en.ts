/** English UI strings. This is the reference catalogue: every locale must provide the same keys. */
export const en = {
  "app.name": "MINT",
  "window.title": "{name} — MINT",
  "window.titleUnsaved": "● {name} — MINT",

  "menu.app": "MINT",
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.window": "Window",
  "menu.quit": "Quit MINT",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",

  "command.file.open": "Open…",
  "command.file.save": "Save",
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

  "dialog.open.title": "Open Document",
  "dialog.filter.markdown": "Markdown",

  "welcome.title": "No document open",
  "welcome.body": "Open a Markdown document to start writing.",
  "welcome.open": "Open Document…",

  "status.saved": "Saved",
  "status.unsaved": "Unsaved changes",

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

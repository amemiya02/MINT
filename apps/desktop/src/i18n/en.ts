/** English UI strings. This is the reference catalogue: every locale must provide the same keys. */
export const en = {
  "app.name": "MINT",
  "window.title": "{name} — MINT",
  "window.titleUnsaved": "● {name} — MINT",

  "menu.app": "MINT",
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.quit": "Quit MINT",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",

  "command.file.open": "Open…",
  "command.file.save": "Save",
  "command.view.toggleSourceMode": "Toggle Source Mode",

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
} as const;

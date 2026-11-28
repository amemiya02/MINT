"""Fill the GTK file chooser on the private Xvfb display used by desktop CI."""

import subprocess
import sys
import time

import pyatspi as atspi
from gi.repository import GLib


title, path, button_name = sys.argv[1:]


def shown(node):
    return node.getState().contains(atspi.STATE_SHOWING)


def chooser():
    for app in atspi.Registry.getDesktop(0):
        for window in app:
            if window.name == title and shown(window):
                return window
    return None


def controls(node):
    yield node
    # A file list may contain thousands of rows. The location field and
    # action buttons are separate GTK widgets outside the directory listing.
    if node.getRoleName() not in ("table", "tree table", "tree", "list"):
        for child in node:
            if child is not None and shown(child):
                yield from controls(child)


def find_control(predicate):
    window = chooser()
    if window is not None:
        return next((node for node in controls(window) if predicate(node)), None)
    return None


def snapshot():
    window = chooser()
    if window is None:
        return [(w.getRoleName(), w.name) for app in atspi.Registry.getDesktop(0) for w in app]
    return [
        (node.getRoleName(), node.name,
         node.queryText().getText(0, -1) if "EditableText" in node.get_interfaces() else "")
        for node in controls(window)
    ]


def wait_for(what, probe):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            result = probe()
        except GLib.Error:
            # GTK replaces its file listing while the location changes.
            result = None
        if result:
            return result
        time.sleep(0.15)
    raise RuntimeError(f"{what} in {title!r}: {snapshot()}")


def accept():
    return find_control(lambda n: n.getRoleName() == "push button" and n.name == button_name)


def editable():
    return find_control(lambda n: "EditableText" in n.get_interfaces() and
                        n.getState().contains(atspi.STATE_EDITABLE))


wait_for("waiting for confirmation button", accept)
subprocess.run(["xdotool", "search", "--onlyvisible", "--name", f"^{title}$",
                "windowfocus", "--sync"], check=True, timeout=5)
if not editable():
    # Folder selection initially shows a breadcrumb. Ctrl+L reveals its path entry.
    subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+l"], check=True)
entry = wait_for("waiting for a location or filename entry", editable)
entry.queryComponent().grabFocus()
entry.queryEditableText().setTextContents(path)
wait_for("checking the full path", lambda: entry.queryText().getText(0, -1) == path)
button = wait_for("waiting for the enabled confirmation button",
                  lambda: (node := accept()) and node.getState().contains(atspi.STATE_SENSITIVE) and node)
button.queryAction().doAction(0)
wait_for("waiting for confirmation to close the chooser", lambda: chooser() is None)

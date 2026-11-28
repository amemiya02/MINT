"""Fill the GTK file chooser on the private Xvfb display used by desktop CI."""

from pathlib import Path
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


def controls(node, include_files=False):
    yield node
    # A file list may contain thousands of rows. The location field and
    # action buttons are separate GTK widgets outside the directory listing.
    if include_files or node.getRoleName() not in ("table", "tree table", "tree", "list"):
        for child in node:
            if child is not None and shown(child):
                yield from controls(child, include_files)


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
        for node in controls(window, include_files=True)
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


def click_node(node, count=1):
    x, y, width, height = node.queryComponent().getExtents(atspi.DESKTOP_COORDS)
    subprocess.run(["xdotool", "mousemove", str(x + width // 2), str(y + height // 2),
                    "click", "--repeat", str(count), "1"], check=True)


def file_cell(name):
    table = find_control(lambda node: node.name == "Files" and node.getRoleName() == "table")
    if table is not None:
        return next((node for node in controls(table, include_files=True) if node.name == name), None)
    return None


wait_for("waiting for confirmation button", accept)
if button_name == "Cancel":
    click_node(wait_for("waiting for Cancel", accept))
    wait_for("waiting for cancellation to close the chooser", lambda: chooser() is None)
    sys.exit(0)

home = wait_for("waiting for GTK Home", lambda: find_control(
    lambda node: node.name == "Home" and node.getRoleName() == "label"))
click_node(home)
target = Path(path)
if button_name == "Open":
    # GTK select-folder needs a highlighted directory row to enable Open.
    # The isolated fixture sits directly under the hosted runner's Home.
    assert target.parent == Path.home()
    folder = wait_for(f"waiting for directory row {target.name!r}", lambda: file_cell(target.name))
    click_node(folder)
else:
    # Navigate through real directory rows so GTK saves under the intended parent.
    for component in target.parent.relative_to(Path.home()).parts:
        folder = wait_for(f"waiting for directory row {component!r}", lambda: file_cell(component))
        click_node(folder, count=2)
    entry = wait_for("waiting for the Save As filename", editable)
    entry.queryComponent().grabFocus()
    entry.queryEditableText().setTextContents(target.name)
    wait_for("checking the filename", lambda: entry.queryText().getText(0, -1) == target.name)

button = wait_for("waiting for the enabled confirmation button",
                  lambda: (node := accept()) and node.getState().contains(atspi.STATE_SENSITIVE) and node)
click_node(button)
wait_for("waiting for confirmation to close the chooser", lambda: chooser() is None)

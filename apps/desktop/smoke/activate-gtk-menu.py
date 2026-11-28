"""Click a menu item in the MINT process on the hosted Xvfb display."""

import subprocess
import sys
import time

import pyatspi as atspi
from gi.repository import GLib


pid, menu_name, item_name = sys.argv[1:]
pid = int(pid)


def shown(node):
    return node is not None and node.getState().contains(atspi.STATE_SHOWING)


def menu_bars(node):
    if not shown(node):
        return
    role = node.getRole()
    if role == atspi.ROLE_MENU_BAR:
        yield node
    elif role != atspi.ROLE_DOCUMENT_WEB:
        for child in node:
            yield from menu_bars(child)


def find_menu():
    for app in atspi.Registry.getDesktop(0):
        if app is None or app.get_process_id() != pid:
            continue
        for window in app:
            if window is not None and window.getRole() == atspi.ROLE_FRAME:
                for bar in menu_bars(window):
                    for menu in bar:
                        if (shown(menu) and menu.name == menu_name and
                                any(item is not None and item.name == item_name for item in menu)):
                            return menu
    return None


def find_item():
    menu = find_menu()
    if menu is not None:
        for item in menu:
            if (shown(item) and item.name == item_name and
                    item.getState().contains(atspi.STATE_SENSITIVE)):
                return item
    return None


def click_when_shown(label, find):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            node = find()
            if node is not None:
                x, y, width, height = node.queryComponent().getExtents(atspi.DESKTOP_COORDS)
                if width > 0 and height > 0:
                    subprocess.run(["xdotool", "mousemove", str(x + width // 2),
                                    str(y + height // 2), "click", "1"], check=True, timeout=5)
                    return
        except GLib.Error:
            # The webview can replace the menu while settings load at startup.
            pass
        time.sleep(0.15)
    raise RuntimeError(f"waiting for GTK menu {label!r} in process {pid}")


click_when_shown(menu_name, find_menu)
click_when_shown(f"{menu_name} > {item_name}", find_item)

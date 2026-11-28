"""Wait for or activate a native GTK menu item on the hosted Xvfb display."""

import sys
import time

import pyatspi as atspi
from gi.repository import GLib


mode, pid, menu_name, item_name = sys.argv[1:]
pid = int(pid)
assert mode in ("wait", "activate")


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


def find_item():
    for app in atspi.Registry.getDesktop(0):
        if app is None or app.get_process_id() != pid:
            continue
        for window in app:
            if window is not None and window.getRole() == atspi.ROLE_FRAME:
                for bar in menu_bars(window):
                    for menu in bar:
                        if not shown(menu) or menu.name != menu_name:
                            continue
                        for item in menu:
                            if item is None or item.name != item_name:
                                continue
                            state = item.getState()
                            if (state.contains(atspi.STATE_VISIBLE) and
                                    state.contains(atspi.STATE_SENSITIVE)):
                                return item
    return None


def wait_for_menu_item():
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            item = find_item()
            if item is not None:
                # GTK's accessible click runs the real menu action without opening a popup.
                action = item.queryAction()
                if action.nActions and (mode == "wait" or action.doAction(0)):
                    return
        except GLib.Error:
            # The webview can replace the menu while settings load at startup.
            pass
        time.sleep(0.15)
    raise RuntimeError(f"cannot {mode} GTK menu {menu_name!r} > {item_name!r} in process {pid}")


wait_for_menu_item()

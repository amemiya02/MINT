import type { MintEditor } from "@mint/editor";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useT } from "../i18n/index.ts";
import { Outline } from "../outline/Outline.tsx";
import { baseName, isDocumentPath, isValidName, joinPath, parentPath } from "../paths.ts";
import type { DirectoryEntry } from "../platform/platform.ts";
import type { FolderTree, TreeRow } from "./file-tree.ts";

export type SidebarView = "files" | "outline";

export type SidebarTool = SidebarView | "backlinks" | "search" | `plugin:${string}`;

export function NavigationRail({
  active,
  onToggle,
  plugins,
}: {
  readonly active: SidebarTool | null;
  readonly plugins: readonly { id: string; label: string }[];
  readonly onToggle: (tool: SidebarTool) => void;
}) {
  const t = useT();
  const tools = [
    { view: "files", label: t("sidebar.files"), icon: <path d="M1.5 4h5l1.5 2h6.5v7H1.5z" /> },
    {
      view: "search",
      label: t("search.label"),
      icon: (
        <>
          <circle cx="6.5" cy="6.5" r="4.5" />
          <path d="m10 10 4 4" />
        </>
      ),
    },
    {
      view: "backlinks",
      label: t("backlinks.label"),
      icon: <path d="M6 4 2 8l4 4M3 8h6a4 4 0 0 0 4-4V2" />,
    },
    { view: "outline", label: t("sidebar.outline"), icon: <path d="M2 3h12M5 8h9M5 13h9" /> },
  ] as const;
  return (
    <nav
      aria-label={t("sidebar.tools")}
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-(--mint-border) bg-(--mint-sidebar-bg) py-2"
    >
      {tools.map(({ view, label, icon }) => (
        <IconButton
          key={view}
          label={label}
          pressed={active === view}
          onClick={() => onToggle(view)}
        >
          {icon}
        </IconButton>
      ))}
      {plugins.map(({ id, label }) => (
        <IconButton
          key={id}
          label={label}
          pressed={active === `plugin:${id}`}
          onClick={() => onToggle(`plugin:${id}`)}
        >
          <path d="M2 2h6l6 6-6 6-6-6z" />
          <circle cx="5.5" cy="5.5" r="1" />
        </IconButton>
      ))}
    </nav>
  );
}

export interface SidebarProps extends Omit<FileTreeProps, "tree"> {
  readonly tree: FolderTree | null;
  readonly view: SidebarView;
  readonly editor: MintEditor | null;
  readonly onOpenFolder: () => void;
  readonly onHide: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { tree, editor, view, onOpenFolder, onHide, ...fileTreeProps } = props;
  const t = useT();
  return (
    <aside
      aria-label={t("sidebar.label")}
      className="flex h-full w-60 shrink-0 flex-col border-r border-(--mint-border) bg-(--mint-sidebar-bg)"
    >
      <header className="flex items-center gap-1 border-b border-(--mint-border) px-2 py-1">
        <span className="flex-1 text-xs font-semibold">
          {t(view === "files" ? "sidebar.files" : "sidebar.outline")}
        </span>
        <IconButton label={t("sidebar.hide")} onClick={onHide}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
          <path d="M6 2.5v11M11 6.5 9.5 8l1.5 1.5" />
        </IconButton>
      </header>
      {view === "outline" ? (
        <Outline editor={editor} />
      ) : tree ? (
        <FileTree key={tree.root} tree={tree} {...fileTreeProps} />
      ) : (
        <button
          type="button"
          className="m-2 self-start rounded px-2 py-1 text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
          onClick={onOpenFolder}
        >
          {t("welcome.openFolder")}
        </button>
      )}
    </aside>
  );
}

interface FileTreeProps {
  /** The open folder. */
  readonly tree: FolderTree;
  /** The document shown in the editor, highlighted in the tree. */
  readonly activePath: string | null;
  /** The single way the sidebar opens a document. */
  readonly onOpenDocument: (path: string) => void;
  /** An entry was renamed; open documents at or under `from` now live under `to`. */
  readonly onRenamed: (from: string, to: string) => void;
  /** An entry was moved to the trash. */
  readonly onTrashed: (path: string) => void;
  readonly onError: (message: string) => void;
}

/** What the inline name field is for. */
type NameEdit =
  | { readonly kind: "create"; readonly type: DirectoryEntry["kind"]; readonly parent: string }
  | { readonly kind: "rename"; readonly entry: DirectoryEntry };

interface ContextMenu {
  readonly x: number;
  readonly y: number;
  /** `null` for the folder root (empty space in the tree). */
  readonly entry: DirectoryEntry | null;
}

/** The file tree of the open folder, with create, rename and trash actions. */
function FileTree(props: FileTreeProps) {
  const { tree, activePath, onOpenDocument, onRenamed, onTrashed, onError } = props;
  const t = useT();
  const { root } = tree;
  const rows = useSyncExternalStore(tree.subscribe, tree.getRows);
  const [edit, setEdit] = useState<NameEdit | null>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function startCreate(type: DirectoryEntry["kind"], parent: string) {
    setMenu(null);
    if (parent !== root) await tree.expand(parent);
    setEdit({ kind: "create", type, parent });
  }

  function defaultName(target: NameEdit): string {
    if (target.kind === "rename") return target.entry.name;
    const stem = t(target.type === "file" ? "tree.untitledDocument" : "tree.untitledFolder");
    const ext = target.type === "file" ? ".md" : "";
    return tree.availableName(target.parent, stem, ext);
  }

  async function commitName(target: NameEdit, typed: string) {
    setEdit(null);
    let name = typed.trim();
    if (target.kind === "rename" && name === target.entry.name) return;
    if (name === "") return;
    if (!isValidName(name)) {
      onError(t("error.invalidName", { name }));
      return;
    }
    if (target.kind === "create") {
      if (target.type === "file" && !name.includes(".")) name += ".md";
      const path = joinPath(target.parent, name);
      try {
        await tree.create(path, target.type);
      } catch (e) {
        onError(t("error.create", { name, reason: reason(e) }));
        return;
      }
      if (target.type === "file") onOpenDocument(path);
    } else {
      const from = target.entry.path;
      const to = joinPath(parentPath(from), name);
      try {
        await tree.rename(from, to);
      } catch (e) {
        onError(t("error.rename", { name, reason: reason(e) }));
        return;
      }
      onRenamed(from, to);
    }
  }

  async function trash(entry: DirectoryEntry) {
    setMenu(null);
    try {
      await tree.trash(entry.path);
    } catch (e) {
      onError(t("error.trash", { name: entry.name, reason: reason(e) }));
      return;
    }
    onTrashed(entry.path);
  }

  function activate(row: TreeRow) {
    const { entry } = row;
    if (entry.kind === "directory") {
      if (row.expanded) tree.collapse(entry.path);
      else void tree.expand(entry.path);
    } else if (isDocumentPath(entry.path)) {
      onOpenDocument(entry.path);
    }
  }

  function openMenu(event: MouseEvent, entry: DirectoryEntry | null) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, entry });
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLDivElement>, row: TreeRow) {
    const items = [...(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])];
    const index = items.indexOf(event.currentTarget);
    const handled = () => event.preventDefault();
    switch (event.key) {
      case "Enter":
        handled();
        return activate(row);
      case "F2":
        handled();
        return setEdit({ kind: "rename", entry: row.entry });
      case "Delete":
        handled();
        return void trash(row.entry);
      case "ArrowDown":
        handled();
        return items[index + 1]?.focus();
      case "ArrowUp":
        handled();
        return items[index - 1]?.focus();
      case "ArrowRight":
        handled();
        if (row.entry.kind === "directory" && !row.expanded) void tree.expand(row.entry.path);
        return;
      case "ArrowLeft":
        handled();
        if (row.expanded) tree.collapse(row.entry.path);
        return;
      case "ContextMenu": {
        handled();
        const box = event.currentTarget.getBoundingClientRect();
        return setMenu({ x: box.left + 16, y: box.bottom, entry: row.entry });
      }
    }
  }

  const nameField = (target: NameEdit, level: number) => (
    <div key="name-field" className="px-2 py-0.5" style={{ paddingLeft: `${level * 12}px` }}>
      <NameField
        initial={defaultName(target)}
        label={t("tree.name")}
        onCommit={(value) => void commitName(target, value)}
        onCancel={() => setEdit(null)}
      />
    </div>
  );

  const items: ReactNode[] = [];
  if (edit?.kind === "create" && edit.parent === root) items.push(nameField(edit, 1));
  rows.forEach((row, index) => {
    const { entry } = row;
    if (edit?.kind === "rename" && edit.entry.path === entry.path) {
      items.push(nameField(edit, row.level));
      return;
    }
    const document = entry.kind === "file" && isDocumentPath(entry.path);
    const disabled = entry.kind === "file" && !document;
    items.push(
      <div
        key={entry.path}
        role="treeitem"
        aria-label={entry.name}
        aria-level={row.level}
        aria-expanded={entry.kind === "directory" ? row.expanded : undefined}
        aria-selected={entry.path === activePath}
        aria-disabled={disabled || undefined}
        tabIndex={index === 0 ? 0 : -1}
        title={entry.path}
        onClick={() => activate(row)}
        onContextMenu={(e) => openMenu(e, entry)}
        onKeyDown={(e) => onRowKeyDown(e, row)}
        className={[
          "flex cursor-default items-center gap-1 truncate rounded-sm py-0.5 pr-2 text-sm outline-none",
          "focus-visible:ring-2 focus-visible:ring-(--mint-accent)",
          entry.path === activePath ? "bg-(--mint-selected)" : "hover:bg-(--mint-hover)",
          disabled ? "text-(--mint-muted) opacity-70" : "",
          entry.kind === "directory" || document ? "font-medium" : "",
        ].join(" ")}
        style={{ paddingLeft: `${row.level * 12 - 4}px` }}
      >
        <span aria-hidden="true" className="w-3 shrink-0 text-center text-(--mint-muted)">
          {entry.kind === "directory" ? (row.expanded ? "▾" : "▸") : ""}
        </span>
        <span className="truncate">{entry.name}</span>
      </div>,
    );
    if (edit?.kind === "create" && edit.parent === entry.path && row.expanded) {
      items.push(nameField(edit, row.level + 1));
    }
  });

  return (
    <>
      <div className="flex items-center gap-1 border-b border-(--mint-border) px-2 py-1">
        <span className="flex-1 truncate text-xs font-semibold" title={root}>
          {baseName(root)}
        </span>
        <IconButton label={t("tree.newDocument")} onClick={() => void startCreate("file", root)}>
          <path d="M9 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L9 1.5Z" />
          <path d="M9 1.5V5h3.5M8 7.5v4M6 9.5h4" />
        </IconButton>
        <IconButton label={t("tree.newFolder")} onClick={() => void startCreate("directory", root)}>
          <path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z" />
          <path d="M8 6.5v4M6 8.5h4" />
        </IconButton>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label={baseName(root)}
        className="min-h-0 flex-1 overflow-auto px-1 py-1"
        onContextMenu={(e) => openMenu(e, null)}
      >
        {items}
      </div>
      {menu && (
        <EntryMenu
          menu={menu}
          onClose={() => setMenu(null)}
          actions={[
            ...(() => {
              const target = menu.entry;
              const parent =
                target === null
                  ? root
                  : target.kind === "directory"
                    ? target.path
                    : parentPath(target.path);
              return [
                { label: t("tree.newDocument"), run: () => void startCreate("file", parent) },
                { label: t("tree.newFolder"), run: () => void startCreate("directory", parent) },
              ];
            })(),
            ...(menu.entry
              ? [
                  {
                    label: t("tree.rename"),
                    run: () => {
                      setMenu(null);
                      if (menu.entry) setEdit({ kind: "rename", entry: menu.entry });
                    },
                  },
                  {
                    label: t("tree.trash"),
                    run: () => {
                      if (menu.entry) void trash(menu.entry);
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
    </>
  );
}

function IconButton(props: {
  readonly pressed?: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      onClick={props.onClick}
      className="flex size-6 [&[aria-pressed]]:size-8 aria-pressed:bg-(--mint-selected) aria-pressed:text-(--mint-fg) items-center justify-center rounded-sm text-sm text-(--mint-muted) hover:bg-(--mint-hover) hover:text-(--mint-fg) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {props.children}
      </svg>
    </button>
  );
}

/** Inline field for naming a new entry or renaming one. Enter or blur commits; Escape cancels. */
function NameField(props: {
  readonly initial: string;
  readonly label: string;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [initial] = useState(props.initial);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, as file managers do.
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) props.onCommit(input.current?.value ?? "");
    else props.onCancel();
  };

  return (
    <input
      ref={input}
      aria-label={props.label}
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={(e) => {
        // Keep the key from reaching the editor that may open next.
        if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className="w-full rounded-sm border border-(--mint-accent) bg-(--mint-bg) px-1 text-sm outline-none"
    />
  );
}

function EntryMenu(props: {
  readonly menu: ContextMenu;
  readonly actions: readonly { readonly label: string; readonly run: () => void }[];
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = props;

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const close = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") items[(index + 1) % items.length]?.focus();
    else if (event.key === "ArrowUp") items[(index - 1 + items.length) % items.length]?.focus();
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-10 min-w-40 rounded-md border border-(--mint-border) bg-(--mint-bg) py-1 text-sm shadow-lg"
      style={{ left: props.menu.x, top: props.menu.y }}
    >
      {props.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={action.run}
          className="block w-full px-3 py-1 text-left hover:bg-(--mint-hover) focus:bg-(--mint-hover) focus:outline-none"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

import { useCallback, useId, useMemo } from "react";
import type { FolderReference } from "../backlinks/references.ts";
import { useFolderReferences } from "../backlinks/useFolderReferences.ts";
import type { FolderTree } from "../folder/file-tree.ts";
import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import type { DocumentLocation } from "../tabs/tab-store.ts";
import type { FolderViewProps } from "./folder-documents.ts";
import { canReadFolder } from "./host.ts";
import { pluginName } from "./Plugins.tsx";

interface GraphProps extends FolderViewProps {
  tree: FolderTree | null;
  wikilinks: boolean;
}

/** One row per document, with directed arcs in the gutter. The list below retains each citation. */
function DocumentNetwork({
  links,
  folder,
  onOpen,
}: {
  links: FolderReference[];
  folder: string;
  onOpen: (path: string) => void;
}) {
  const t = useT();
  const arrow = useId();
  const { nodes, arcs } = useMemo(() => {
    const documents = new Map<string, { row: number; targets: Set<number> }>();
    function node(path: string) {
      const existing = documents.get(path);
      if (existing) return existing;
      const document = { row: documents.size, targets: new Set<number>() };
      documents.set(path, document);
      return document;
    }
    for (const { sourcePath, targetPath } of links) {
      node(sourcePath).targets.add(node(targetPath).row);
    }
    const arcs = [];
    for (const { row, targets } of documents.values()) {
      for (const target of targets) {
        const start = row * 32 + 12;
        const end = target * 32 + 20;
        const bend = Math.max(3, 35 - Math.abs(end - start) / 8);
        arcs.push(
          <path
            key={`${row}-${target}`}
            d={`M 61 ${start} C ${bend} ${start}, ${bend} ${end}, 59 ${end}`}
          />,
        );
      }
    }
    return { nodes: [...documents.keys()], arcs };
  }, [links]);
  return (
    <nav aria-label={t("graph.documents")} className="relative shrink-0">
      <svg
        aria-hidden="true"
        width="64"
        height={32 * nodes.length}
        className="pointer-events-none absolute top-0 left-0 text-(--mint-accent)"
      >
        <defs>
          <marker
            id={arrow}
            viewBox="0 0 6 6"
            refX="5"
            refY="3"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0 0 6 3 0 6z" fill="currentColor" />
          </marker>
        </defs>
        <g fill="none" stroke="currentColor" markerEnd={`url(#${arrow})`}>
          {arcs}
        </g>
      </svg>
      {nodes.map((path) => (
        <button
          type="button"
          key={path}
          className="ml-[64px] block h-[32px] max-w-[calc(100%-64px)] truncate rounded px-1 text-left hover:bg-(--mint-hover)"
          title={relativePath(folder, path)}
          onClick={() => onOpen(path)}
        >
          {relativePath(folder, path)}
        </button>
      ))}
    </nav>
  );
}

export function RelationshipGraph({
  manifest,
  granted,
  tree,
  wikilinks,
  platform,
  onOpen,
}: GraphProps) {
  const t = useT();
  const folder = tree?.root;
  const hasAccess = useCallback(() => canReadFolder(manifest.id), [manifest.id]);
  const links = useFolderReferences(
    platform,
    granted ? tree : null,
    wikilinks,
    undefined,
    hasAccess,
  );
  function openDocument(path: string, location?: DocumentLocation) {
    if (hasAccess()) onOpen(path, location);
  }
  const node =
    "min-w-0 break-all rounded border border-(--mint-border) px-2 py-1 text-left hover:bg-(--mint-hover)";
  return (
    <aside
      aria-label={pluginName(manifest, t)}
      className="flex h-full w-72 shrink-0 flex-col gap-2 overflow-auto border-r border-(--mint-border) bg-(--mint-sidebar-bg) p-2 text-sm"
    >
      <h2 className="font-semibold">{pluginName(manifest, t)}</h2>
      {!granted ? (
        <p role="alert">{t("plugin.folderDenied")}</p>
      ) : !folder ? (
        <p>{t("graph.needFolder")}</p>
      ) : links === "error" ? (
        <p role="alert">{t("plugin.folderError")}</p>
      ) : !links ? (
        <p>{t("search.searching")}</p>
      ) : !links.length ? (
        <p>{t("graph.empty")}</p>
      ) : (
        <>
          <DocumentNetwork links={links} folder={folder} onOpen={openDocument} />
          <h3 className="font-medium">{t("graph.references")}</h3>
          <ul aria-label={t("graph.references")} className="space-y-2">
            {links.map((link) => (
              <li
                key={JSON.stringify([link.sourcePath, link.from])}
                className="grid grid-cols-[1fr_auto_1fr] items-center gap-1"
              >
                <button
                  type="button"
                  className={node}
                  title={link.context}
                  onClick={() => openDocument(link.sourcePath, { citation: link })}
                >
                  {relativePath(folder, link.sourcePath)}
                  <small className="block">
                    {link.line}:{link.column}
                  </small>
                </button>
                <span>→</span>
                <button
                  type="button"
                  className={node}
                  onClick={() =>
                    openDocument(
                      link.targetPath,
                      link.target.fragment ? { fragment: link.target.fragment } : undefined,
                    )
                  }
                >
                  {relativePath(folder, link.targetPath)}
                  {link.target.fragment && <small className="block">#{link.target.fragment}</small>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

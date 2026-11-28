import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import { useTabStore } from "../tabs/context.ts";
import type { FolderViewProps } from "./folder-documents.ts";
import { type FolderDocument, propertiesOf, useFolderProperties } from "./folder-properties.ts";
import { canMoveCard, canReadFolder } from "./host.ts";
import { withStatus } from "./kanban-status.ts";
import { pluginName } from "./Plugins.tsx";

function statusOf(card: Pick<FolderDocument, "properties">) {
  return typeof card.properties.status === "string" ? card.properties.status : "";
}

export function KanbanBoard(props: FolderViewProps) {
  const { manifest, folder, platform, granted, onOpen } = props;
  const t = useT();
  const store = useTabStore();
  const [revision, setRevision] = useState(0);
  const { documents, failed } = useFolderProperties(props, revision);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const dragged = useRef<FolderDocument | null>(null);
  const canWrite = canMoveCard(manifest.id);
  const statuses = [
    ...new Set([
      t("kanban.todo"),
      t("kanban.inProgress"),
      t("kanban.done"),
      ...(documents ?? []).map(statusOf),
    ]),
  ];
  async function move(card: FolderDocument, status: string) {
    if (!folder || !status || statusOf(card) === status || moving || !canMoveCard(manifest.id))
      return;
    setMoving(true);
    setError("");
    try {
      const before = await platform.readTextFile(card.path);
      if (
        !active.current ||
        !canMoveCard(manifest.id) ||
        store.getState().tabs.some((tab) => tab.path === card.path && tab.dirty)
      )
        throw new Error("Document unavailable for editing");
      if (statusOf({ properties: propertiesOf(before) }) !== statusOf(card))
        throw new Error("Status changed");
      const after = withStatus(before, status);
      if (propertiesOf(after).status !== status) throw new Error("Invalid status edit");
      await platform.applyDocumentEdit({ from: card.path, to: card.path, before, after });
    } catch {
      setError(t("kanban.failed", { name: relativePath(folder, card.path) }));
    } finally {
      setRevision((r) => r + 1);
      setMoving(false);
    }
  }
  return (
    <aside
      aria-label={pluginName(manifest, t)}
      className="h-full w-[32rem] max-w-[60%] shrink-0 overflow-auto border-r border-(--mint-border) bg-(--mint-sidebar-bg) p-2 text-sm"
    >
      <h2 className="mb-2 font-semibold">{pluginName(manifest, t)}</h2>
      {granted && error && <p role="alert">{error}</p>}
      {!granted ? (
        <p role="alert">{t("plugin.folderDenied")}</p>
      ) : !folder ? (
        <p>{t("plugin.propertyFolder")}</p>
      ) : failed ? (
        <p role="alert">{t("plugin.folderError")}</p>
      ) : !documents ? (
        <p>{t("plugin.loadingProperties")}</p>
      ) : !documents.length ? (
        <p>{t("plugin.noDocuments")}</p>
      ) : (
        <>
          {!canWrite && <p>{t("kanban.readOnly")}</p>}
          <div className="flex min-h-36 gap-2">
            {statuses.map((status) => (
              <section
                key={status}
                aria-label={status || t("kanban.unassigned")}
                className="w-36 shrink-0 rounded border border-(--mint-border) p-2"
                onDragOver={(e) => {
                  if (dragged.current && canWrite && status) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragged.current) void move(dragged.current, status);
                  dragged.current = null;
                }}
              >
                <h3 className="mb-2 font-semibold">{status || t("kanban.unassigned")}</h3>
                {documents
                  .filter((card) => statusOf(card) === status)
                  .map((card) => {
                    const name = relativePath(folder, card.path);
                    return (
                      <article
                        key={card.path}
                        draggable={canWrite && !moving}
                        onDragStart={(e) => {
                          dragged.current = card;
                          e.dataTransfer.setData("text/plain", name);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => {
                          dragged.current = null;
                        }}
                        className="mb-2 rounded border border-(--mint-border) p-2"
                      >
                        <button
                          type="button"
                          className="break-all text-left underline"
                          onClick={() => {
                            if (canReadFolder(manifest.id)) onOpen(card.path);
                          }}
                        >
                          {name}
                        </button>
                        <select
                          className="mt-1 w-full"
                          aria-label={t("kanban.move", { name })}
                          disabled={!canWrite || moving}
                          value={status}
                          onChange={(e) => void move(card, e.target.value)}
                        >
                          {statuses
                            .filter((s) => s || !status)
                            .map((s) => (
                              <option key={s} value={s} disabled={!s}>
                                {s || t("kanban.unassigned")}
                              </option>
                            ))}
                        </select>
                      </article>
                    );
                  })}
              </section>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

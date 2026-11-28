import { useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { baseName, joinPath, parentPath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { useTabStore } from "../tabs/context.ts";
import { applyFolderChange, type FolderChange } from "./folder-changes.ts";
import { ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";

const button = "rounded border border-(--mint-border) px-2 py-1";

export function FolderWritingReview({
  root,
  changes,
  platform,
  source,
  busy,
  batch,
  retry,
  revert,
  decide,
}: {
  readonly root: string;
  readonly changes: readonly FolderChange[];
  readonly platform: Platform;
  readonly source: boolean;
  readonly busy: boolean;
  readonly batch: boolean;
  readonly retry: () => Promise<void>;
  readonly revert: (position?: number) => Promise<void>;
  readonly decide: (position: number, status: "applied" | "discarded" | "kept") => void;
}) {
  const t = useT();
  const store = useTabStore();
  const locked = useRef(false);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<{
    position: number;
    kind: "failed" | "conflict" | "saveFirst" | "missingDependency";
  }>();
  const applied = new Set(
    changes.filter(({ status }) => status === "applied").map(({ path }) => path),
  );
  async function apply(change: FolderChange, position: number) {
    if (locked.current) return;
    locked.current = true;
    setApplying(true);
    setFailure(undefined);
    try {
      try {
        await Promise.all(
          change.requires.map((path) => platform.readTextFile(joinPath(root, path))),
        );
      } catch {
        setFailure({ position, kind: "missingDependency" });
        return;
      }
      const result = await applyFolderChange(platform, store, root, change);
      if (result === "applied") decide(position, result);
      else setFailure({ position, kind: result });
    } catch {
      setFailure({ position, kind: "failed" });
    } finally {
      setApplying(false);
      locked.current = false;
    }
  }

  return (
    <section aria-label={t("writing.folder.changes")} className="space-y-2">
      <h3 className="font-medium">{t("writing.folder.changes")}</h3>
      {!changes.length && <p>{t("writing.edit.unchanged")}</p>}
      {batch && (
        <div className="flex flex-wrap gap-2">
          {changes.some(({ status }) => status === "preview") && (
            <button type="button" className={button} disabled={busy} onClick={() => void retry()}>
              {t("writing.folder.retry")}
            </button>
          )}
          {applied.size > 0 && (
            <button type="button" className={button} disabled={busy} onClick={() => void revert()}>
              {t("writing.edit.revertAll")}
            </button>
          )}
        </div>
      )}
      {changes.map((change, position) => {
        const { path, from, before, text, requires, status } = change;
        const kind =
          from === undefined
            ? before === undefined
              ? "create"
              : "modify"
            : parentPath(from) === parentPath(path)
              ? "rename"
              : baseName(from) === baseName(path)
                ? "move"
                : "moveRename";
        const blocked = requires.some((destination) => !applied.has(destination));
        if (status === "outside")
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: Rejected duplicate paths stay in reply order.
            <p key={position}>{t("writing.folder.outside", { path })}</p>
          );
        return (
          <ProposedSelectionEdit
            // biome-ignore lint/suspicious/noArrayIndexKey: Positions identify proposals within one fixed reply.
            key={position}
            label={t(`writing.folder.${kind}`, { path, from: from ?? "" })}
            before={before ?? ""}
            after={text}
            status={status}
            statusLabel={batch && status === "applied" ? t("writing.folder.written") : undefined}
            source={source}
            showAppliedComparison={change.undoResult === "conflict" && change.current !== undefined}
            current={change.current}
            busy={busy || applying}
            applyDisabled={blocked}
            onApply={
              !batch && status === "preview" ? () => void apply(change, position) : undefined
            }
            onDiscard={status === "preview" ? () => decide(position, "discarded") : undefined}
            conversation={
              <>
                {change.result && <p role="alert">{t(`writing.folder.${change.result}`)}</p>}
                {change.undoResult && (
                  <p role="alert">{t(`writing.folder.undo.${change.undoResult}`)}</p>
                )}
                {requires.length > 0 && (
                  <p>{t("writing.folder.requires", { paths: requires.join(", ") })}</p>
                )}
                {failure?.position === position && (
                  <p role="alert">{t(`writing.folder.${failure.kind}`)}</p>
                )}
                {batch && status === "applied" && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => void revert(position)}
                    >
                      {t("writing.folder.revert")}
                    </button>
                    {change.undoResult === "conflict" && (
                      <button
                        type="button"
                        className={button}
                        disabled={busy}
                        onClick={() => decide(position, "kept")}
                      >
                        {t("writing.edit.keepCurrent")}
                      </button>
                    )}
                  </div>
                )}
              </>
            }
          />
        );
      })}
    </section>
  );
}

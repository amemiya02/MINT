import { useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { baseName, joinPath, parentPath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { useTabStore } from "../tabs/context.ts";
import { applyFolderChange, type FolderChange } from "./folder-changes.ts";
import { ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";

export function FolderWritingReview({
  root,
  changes,
  platform,
  source,
  busy,
  decide,
}: {
  readonly root: string;
  readonly changes: readonly FolderChange[];
  readonly platform: Platform;
  readonly source: boolean;
  readonly busy: boolean;
  readonly decide: (position: number, status: "applied" | "discarded") => void;
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
            source={source}
            busy={busy || applying}
            applyDisabled={blocked}
            onApply={status === "preview" ? () => void apply(change, position) : undefined}
            onDiscard={status === "preview" ? () => decide(position, "discarded") : undefined}
            conversation={
              <>
                {requires.length > 0 && (
                  <p>{t("writing.folder.requires", { paths: requires.join(", ") })}</p>
                )}
                {failure?.position === position && (
                  <p role="alert">{t(`writing.folder.${failure.kind}`)}</p>
                )}
              </>
            }
          />
        );
      })}
    </section>
  );
}

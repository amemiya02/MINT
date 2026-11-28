import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { baseName } from "../paths.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { type WritingTask, writingTaskDecisionLabel } from "./WritingTasks.tsx";
import {
  openWritingReviews,
  type SavedWritingTask,
  type WritingTasksPlatform,
  writeTaskCheckpoint,
  writingTaskWrites,
} from "./writing-tasks.ts";

export function WritingTasksDialog({
  tasks,
  liveTasks,
  path,
  currentTabIds,
  all,
  onScopeChange,
  onClose,
  onOpen,
  onDelete,
}: {
  readonly tasks: WritingTasksPlatform;
  readonly liveTasks: ReadonlyMap<string, WritingTask>;
  readonly path: string | null;
  readonly currentTabIds: ReadonlySet<number>;
  readonly all: boolean;
  readonly onScopeChange: (all: boolean) => void;
  readonly onClose: () => void;
  readonly onOpen: (task: SavedWritingTask | WritingTask) => Promise<boolean | "temporary">;
  readonly onDelete: (id: string) => void;
}) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const [entries, setEntries] = useState<readonly SavedWritingTask[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openFailure, setOpenFailure] = useState<
    "writing.tasks.openFailed" | "writing.temporary.closeBeforeOpening" | null
  >(null);
  const [opening, setOpening] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void writingTaskWrites(tasks)
      .then(() => tasks.list(path, all))
      .then(
        (items) => {
          if (current) setEntries(items.sort((a, b) => b.updatedAt - a.updatedAt));
        },
        () => {
          if (current) setFailed(true);
        },
      );
    return () => {
      current = false;
    };
  }, [tasks, path, all]);

  const reviews = openWritingReviews(tasks);
  const saved = new Map(
    (entries ?? [])
      .filter((task) => {
        if (all) return true;
        const review = reviews.get(task.id);
        const tabId = liveTasks.get(task.id)?.tabId ?? review?.tabId;
        return !task.folder && (path !== null || (tabId !== undefined && currentTabIds.has(tabId)));
      })
      .map((task) => [task.id, task]),
  );
  const live = [...liveTasks].filter(
    ([, task]) => all || (!task.folder && currentTabIds.has(task.tabId)),
  );
  const rowIds = new Set([...live.map(([id]) => id), ...saved.keys()]);

  async function open(task: SavedWritingTask | WritingTask) {
    setOpenFailure(null);
    setOpening(true);
    try {
      const result = await onOpen(task);
      if (result === true) close();
      else
        setOpenFailure(
          result === "temporary"
            ? "writing.temporary.closeBeforeOpening"
            : "writing.tasks.openFailed",
        );
    } catch {
      setOpenFailure("writing.tasks.openFailed");
    } finally {
      setOpening(false);
    }
  }

  async function remove(id: string) {
    if (!entries || deleting) return;
    if (openWritingReviews(tasks).get(id)?.busy) {
      setDeleteFailed(true);
      return;
    }
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await writeTaskCheckpoint(tasks, () => tasks.remove(id));
      setEntries(entries.filter((entry) => entry.id !== id));
      setConfirm(null);
      onDelete(id);
    } catch {
      setDeleteFailed(true);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <dialog
      {...props}
      onCancel={(event) => {
        if (opening || deleting) {
          event.preventDefault();
          return;
        }
        if (confirm) {
          event.preventDefault();
          setConfirm(null);
        } else props.onCancel(event);
      }}
      aria-label={t(all ? "writing.tasks.all" : "writing.tasks")}
      className="m-auto max-h-[80vh] w-[min(32rem,90vw)] overflow-auto rounded-lg border border-(--mint-border) bg-(--mint-bg) p-4 text-(--mint-fg) backdrop:bg-black/30"
    >
      <header className="mb-3 flex items-center gap-2">
        <h2 className="mr-auto font-medium">{t(all ? "writing.tasks.all" : "writing.tasks")}</h2>
        {(!all || currentTabIds.size > 0) && (
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-(--mint-hover)"
            disabled={opening || deleting}
            onClick={() => onScopeChange(!all)}
          >
            {t(all ? "writing.tasks.current" : "writing.tasks.all")}
          </button>
        )}
        <button
          type="button"
          disabled={opening || deleting}
          className="rounded px-2 py-1 hover:bg-(--mint-hover)"
          onClick={close}
        >
          {t("settings.close")}
        </button>
      </header>
      {openFailure && <p role="alert">{t(openFailure)}</p>}
      {failed && <p role="alert">{t("writing.tasks.loadFailed")}</p>}
      {!failed && !entries && <p role="status">{t("writing.tasks.loading")}</p>}
      {!!entries && !rowIds.size && (
        <p>{t(all ? "writing.tasks.allEmpty" : "writing.tasks.empty")}</p>
      )}
      {rowIds.size > 0 && (
        <ul className="space-y-2">
          {[...rowIds].map((id) => {
            const record = saved.get(id);
            const running = liveTasks.get(id);
            const item = running ?? record;
            if (!item) return null;
            const location = item.folder
              ? t("writing.tasks.folder", { folder: item.folder })
              : (running?.name ??
                (record?.path ? baseName(record.path) : t("writing.scope.untitled")));
            const decisions =
              running?.decisions ??
              record?.turns.reduce(
                (count, turn) =>
                  count +
                  (turn.suggestions?.filter(({ status }) => status === "preview").length ?? 0),
                0,
              ) ??
              0;
            const status =
              running?.status ??
              (record?.pending ? "interrupted" : (record?.turns.at(-1)?.status ?? "complete"));
            return (
              <li key={id} className="space-y-2 rounded border border-(--mint-border) p-2">
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded p-1 text-start wrap-anywhere hover:bg-(--mint-hover)"
                    disabled={opening || deleting}
                    onClick={() => void open(item)}
                  >
                    {item.title}
                  </button>
                  {record && (
                    <button
                      type="button"
                      className="rounded px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50"
                      aria-label={t("writing.tasks.deleteNamed", { title: item.title })}
                      disabled={opening || deleting || !!running?.stop || reviews.get(id)?.busy}
                      onClick={() => {
                        setConfirm(id);
                        setDeleteFailed(false);
                      }}
                    >
                      {t("writing.tasks.delete")}
                    </button>
                  )}
                </div>
                <p className="px-1 text-xs wrap-anywhere">
                  {location} · {t(`writing.task.${status}`)}
                  {decisions > 0 && <> · {writingTaskDecisionLabel(t, decisions)}</>}
                </p>
                {running && (
                  <p className="px-1 text-xs wrap-anywhere">
                    {running.recipient} · {running.material}
                  </p>
                )}
                {record && (
                  <time className="px-1 text-xs text-(--mint-muted)">
                    {new Date(record.updatedAt).toLocaleString()}
                  </time>
                )}
                {confirm === id && (
                  <div className="space-y-2 border-t border-(--mint-border) pt-2 text-sm">
                    <p>{t("writing.tasks.deletePrompt")}</p>
                    {deleteFailed && <p role="alert">{t("writing.tasks.deleteFailed")}</p>}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded border border-(--mint-border) px-2 py-1"
                        disabled={deleting}
                        onClick={() => setConfirm(null)}
                      >
                        {t("unsaved.cancel")}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-(--mint-border) px-2 py-1"
                        disabled={deleting}
                        onClick={() => void remove(id)}
                      >
                        {t("writing.tasks.deleteConfirm")}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </dialog>
  );
}

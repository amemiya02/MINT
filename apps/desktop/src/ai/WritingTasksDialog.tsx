import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import {
  type SavedWritingTask,
  type WritingTasksPlatform,
  writingTaskWrites,
} from "./writing-tasks.ts";

export function WritingTasksDialog({
  tasks,
  path,
  busyTask,
  onClose,
  onOpen,
  onDelete,
}: {
  readonly tasks: WritingTasksPlatform;
  readonly path: string | null;
  readonly busyTask: string | null;
  readonly onClose: () => void;
  readonly onOpen: (task: SavedWritingTask) => boolean;
  readonly onDelete: (id: string, remaining: number) => void;
}) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const [entries, setEntries] = useState<readonly SavedWritingTask[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void writingTaskWrites(tasks)
      .then(() => tasks.list(path))
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
  }, [tasks, path]);

  async function remove(id: string) {
    if (!entries || deleting || id === busyTask) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await tasks.remove(id);
      const remaining = entries.filter((entry) => entry.id !== id);
      setEntries(remaining);
      setConfirm(null);
      onDelete(id, remaining.length);
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
        if (confirm) {
          event.preventDefault();
          if (!deleting) setConfirm(null);
        } else props.onCancel(event);
      }}
      aria-label={t("writing.tasks")}
      className="m-auto max-h-[80vh] w-[min(32rem,90vw)] overflow-auto rounded-lg border border-(--mint-border) bg-(--mint-bg) p-4 text-(--mint-fg) backdrop:bg-black/30"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-medium">{t("writing.tasks")}</h2>
        <button
          type="button"
          disabled={deleting}
          className="rounded px-2 py-1 hover:bg-(--mint-hover)"
          onClick={close}
        >
          {t("settings.close")}
        </button>
      </header>
      {openFailed && <p role="alert">{t("writing.tasks.openUntitled")}</p>}
      {failed ? (
        <p role="alert">{t("writing.tasks.loadFailed")}</p>
      ) : !entries ? (
        <p role="status">{t("writing.tasks.loading")}</p>
      ) : entries.length === 0 ? (
        <p>{t("writing.tasks.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((task) => (
            <li key={task.id} className="space-y-2 rounded border border-(--mint-border) p-2">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded p-1 text-start wrap-anywhere hover:bg-(--mint-hover)"
                  disabled={deleting || (busyTask !== null && busyTask !== task.id)}
                  onClick={() => {
                    if (onOpen(task)) close();
                    else setOpenFailed(true);
                  }}
                >
                  {task.title}
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50"
                  aria-label={t("writing.tasks.deleteNamed", { title: task.title })}
                  disabled={deleting || busyTask === task.id}
                  onClick={() => {
                    setConfirm(task.id);
                    setDeleteFailed(false);
                  }}
                >
                  {t("writing.tasks.delete")}
                </button>
              </div>
              <time className="px-1 text-xs text-(--mint-muted)">
                {new Date(task.updatedAt).toLocaleString()}
              </time>
              {confirm === task.id && (
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
                      onClick={() => void remove(task.id)}
                    >
                      {t("writing.tasks.deleteConfirm")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}

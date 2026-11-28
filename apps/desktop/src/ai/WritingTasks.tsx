import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { type Translate, useT } from "../i18n/index.ts";
import { materialLabel } from "./material-display.ts";
import { MaterialPreview } from "./TaskContext.tsx";
import type { AttemptStatus } from "./writing-attempt.ts";
import type { NamedMaterial, WritingRequest } from "./writing-sender.ts";

export interface WritingTask {
  readonly id?: string;
  readonly tabId: number;
  readonly title: string;
  readonly name: string;
  readonly folder?: string;
  readonly recipient: string;
  readonly material: string;
  readonly status: AttemptStatus;
  readonly count: number;
  readonly decisions?: number;
  readonly notice?: { readonly id: string; readonly detail?: string; readonly decisions?: number };
  readonly background?: boolean;
  readonly stop?: () => void;
  readonly forget?: () => void;
  readonly reveal: () => void;
}

export const WritingTasksContext = createContext<(id: string, task: WritingTask | null) => void>(
  () => {},
);

export function useWritingTask(task: WritingTask | null) {
  const publish = useContext(WritingTasksContext);
  const localId = useId();
  const id = task?.id ?? localId;
  useEffect(() => {
    publish(id, task);
  }, [id, publish, task]);
  useEffect(() => () => publish(id, null), [id, publish]);
}

export function writingTaskDecisionLabel(t: Translate, count: number) {
  return t(count === 1 ? "writing.tasks.oneDecision" : "writing.tasks.decisions", {
    count: String(count),
  });
}

export function WritingTaskNotices({
  tasks,
  onReveal,
}: {
  readonly tasks: ReadonlyMap<string, WritingTask>;
  readonly onReveal: (task: WritingTask) => void;
}) {
  const t = useT();
  const seen = useRef(new Set<string>());
  const [announced, setAnnounced] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const next = new Set<string>();
    const current = new Set<string>();
    for (const task of tasks.values()) {
      const id = task.notice?.id;
      if (!id) continue;
      if (task.background) {
        current.add(id);
        if (!seen.current.has(id)) next.add(id);
      }
      seen.current.add(id);
    }
    setAnnounced((previous) => {
      const retained = [...previous].filter((id) => current.has(id));
      return !next.size && retained.length === previous.size
        ? previous
        : new Set([...retained, ...next]);
    });
  }, [tasks]);

  function dismiss(id: string) {
    setAnnounced((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }

  return (
    <section
      aria-label={t("writing.tasks.notifications")}
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-12 z-30 flex max-w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {[...tasks.values()].flatMap((task) => {
        const notice = task.notice;
        if (!notice || !task.background || !announced.has(notice.id)) return [];
        return (
          <div
            key={notice.id}
            className="pointer-events-auto space-y-1 rounded border border-(--mint-border) bg-(--mint-bg) p-2 text-sm wrap-anywhere shadow-lg"
          >
            <p>
              {task.folder ? t("writing.tasks.folder", { folder: task.folder }) : task.name} ·{" "}
              {t(`writing.task.${task.status}`)}
            </p>
            {(notice.detail || !!notice.decisions) && (
              <p className="text-xs text-(--mint-muted)">
                {[
                  notice.detail,
                  notice.decisions ? writingTaskDecisionLabel(t, notice.decisions) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <div className="flex gap-3">
              <button
                className="underline"
                type="button"
                onClick={() => {
                  dismiss(notice.id);
                  onReveal(task);
                }}
              >
                {t("writing.task.open", { name: task.name })}
              </button>
              <button className="underline" type="button" onClick={() => dismiss(notice.id)}>
                {t("writing.tasks.dismissNotice")}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function WritingTasks({
  tasks,
  onAllTasks,
  onReveal,
}: {
  readonly tasks: ReadonlyMap<string, WritingTask>;
  readonly onAllTasks: () => void;
  readonly onReveal: (task: WritingTask) => void;
}) {
  const t = useT();
  const drawer = useRef<HTMLDetailsElement>(null);
  if (!tasks.size) return null;
  return (
    <section
      aria-label={t("writing.tasks")}
      className="relative z-20 shrink-0 border-b border-l border-(--mint-border) bg-(--mint-bg) text-sm"
    >
      <details ref={drawer}>
        <summary className="h-8 cursor-pointer px-3 py-1.5">{t("writing.tasks")}</summary>
        <ul className="absolute top-full right-0 max-h-40 w-[min(28rem,calc(100vw-3rem))] space-y-1 overflow-auto wrap-anywhere rounded-md border border-(--mint-border) bg-(--mint-bg) p-2 shadow-lg">
          <li>
            <button
              className="underline"
              type="button"
              onClick={() => {
                if (drawer.current) drawer.current.open = false;
                onAllTasks();
              }}
            >
              {t("writing.tasks.all")}
            </button>
          </li>
          {[...tasks].map(([id, task]) => (
            <li key={id} className="flex flex-wrap items-baseline gap-x-3">
              <button
                className="underline"
                type="button"
                onClick={() => {
                  if (drawer.current) drawer.current.open = false;
                  onReveal(task);
                }}
              >
                {t("writing.task.open", { name: task.name })}
              </button>
              <span>{task.recipient}</span>
              <span>{task.material}</span>
              <span role="status">
                {t(`writing.task.${task.status}`)} ·{" "}
                {task.count === 1
                  ? t("writing.task.one")
                  : t("writing.task.count", { count: String(task.count) })}
              </span>
              {task.stop && (
                <button className="underline" type="button" onClick={task.stop}>
                  {t("writing.task.stop")}
                </button>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export function WritingTaskMaterials({
  request,
  approved,
  folder,
}: {
  readonly request: WritingRequest;
  readonly approved: readonly NamedMaterial[];
  readonly folder: string | null;
}) {
  const t = useT();
  const context = request.taskContext;
  const materials = [
    ...(request.selectedText === undefined
      ? []
      : [{ name: t("writing.scope.selection"), text: request.selectedText }]),
    ...(context?.currentDraft ? [context.currentDraft] : []),
    ...(request.folderDocuments?.map(({ path, text }) => ({ name: path, text })) ?? []),
    ...(context?.materials ?? []),
    ...approved,
  ];
  if (!materials.length && !folder) return null;
  return (
    <details aria-label={t("writing.task.materials")} className="space-y-1 text-xs wrap-anywhere">
      <summary className="cursor-pointer">{t("writing.task.materials")}</summary>
      {folder && <p>{folder}</p>}
      {materials.map((material, position) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: The material list is append-only and names may repeat.
        <details key={`${material.name}:${position}`}>
          <summary className="cursor-pointer">{materialLabel(material, t)}</summary>
          <MaterialPreview material={material} />
        </details>
      ))}
    </details>
  );
}

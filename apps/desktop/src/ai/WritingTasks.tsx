import { createContext, useContext, useEffect, useId } from "react";
import { useT } from "../i18n/index.ts";
import type { AttemptStatus } from "./writing-attempt.ts";
import type { NamedMaterial, WritingRequest } from "./writing-sender.ts";

export interface WritingTask {
  readonly tabId: number;
  readonly name: string;
  readonly recipient: string;
  readonly material: string;
  readonly status: AttemptStatus;
  readonly count: number;
  readonly stop?: () => void;
  readonly reveal: () => void;
}

export const WritingTasksContext = createContext<(id: string, task: WritingTask | null) => void>(
  () => {},
);

export function useWritingTask(task: WritingTask | null) {
  const publish = useContext(WritingTasksContext);
  const id = useId();
  useEffect(() => {
    publish(id, task);
  }, [id, publish, task]);
  useEffect(() => () => publish(id, null), [id, publish]);
}

export function WritingTasks({
  tasks,
  activeId,
}: {
  readonly tasks: ReadonlyMap<string, WritingTask>;
  readonly activeId: number | null;
}) {
  const t = useT();
  if (!tasks.size) return null;
  return (
    <section
      aria-label={t("writing.tasks")}
      className="absolute top-2 right-3 z-20 max-w-[min(30rem,calc(100%-1.5rem))] rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 text-sm shadow-sm"
    >
      <details open={[...tasks.values()].some((task) => task.tabId !== activeId)}>
        <summary className="cursor-pointer">{t("writing.tasks")}</summary>
        <ul className="mt-1 max-h-36 space-y-1 overflow-auto wrap-anywhere">
          {[...tasks].map(([id, task]) => (
            <li key={id} className="flex flex-wrap items-baseline gap-x-3">
              <button className="underline" type="button" onClick={task.reveal}>
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
    ...(context?.materials ?? []),
    ...approved,
  ];
  if (!materials.length && !folder) return null;
  return (
    <details aria-label={t("writing.task.materials")} className="space-y-1 text-xs wrap-anywhere">
      <summary className="cursor-pointer">{t("writing.task.materials")}</summary>
      {folder && <p>{folder}</p>}
      {materials.map(({ name, text }, position) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: The material list is append-only and names may repeat.
        <details key={`${name}:${position}`}>
          <summary className="cursor-pointer">{name}</summary>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap wrap-anywhere">{text}</pre>
        </details>
      ))}
    </details>
  );
}

import { createContext, useContext, useEffect, useId, useRef } from "react";
import { useT } from "../i18n/index.ts";
import type { AttemptStatus } from "./writing-attempt.ts";
import type { NamedMaterial, WritingRequest } from "./writing-sender.ts";

export interface WritingTask {
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

export function WritingTasks({ tasks }: { readonly tasks: ReadonlyMap<string, WritingTask> }) {
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
          {[...tasks].map(([id, task]) => (
            <li key={id} className="flex flex-wrap items-baseline gap-x-3">
              <button
                className="underline"
                type="button"
                onClick={() => {
                  if (drawer.current) drawer.current.open = false;
                  task.reveal();
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

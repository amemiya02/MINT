import { createContext, useContext, useEffect, useId } from "react";
import { useT } from "../i18n/index.ts";
import type { AttemptStatus } from "./writing-attempt.ts";

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

export const WritingTasksContext = createContext<
  (id: string, task: WritingTask | null) => void
>(() => {});

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
    <section aria-label={t("writing.tasks")} className="border-b border-(--mint-border) px-4 py-1 text-sm">
      <details open={[...tasks.values()].some((task) => task.tabId !== activeId)}>
        <summary className="cursor-pointer">{t("writing.tasks")}</summary>
        <ul className="max-h-36 space-y-1 overflow-auto">
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

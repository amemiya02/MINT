import { markdownTasks } from "@mint/markdown";
import type { FolderTree } from "../folder/file-tree.ts";
import { useFolderRows } from "../folder/useFolderRows.ts";
import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import { type FolderViewProps, useFolderDocuments } from "./folder-documents.ts";
import { canReadFolder } from "./host.ts";
import { pluginName } from "./Plugins.tsx";

function documentTasks(path: string, source: string) {
  return markdownTasks(source).map((task) => ({ ...task, path }));
}

export function TaskSummary(props: FolderViewProps & { tree: FolderTree | null }) {
  const { folder, manifest, granted, onOpen } = props;
  const t = useT();
  const revision = useFolderRows(granted ? props.tree : null);
  const { documents, failed } = useFolderDocuments(props, documentTasks, revision);
  const tasks = documents?.flat();
  return (
    <aside
      aria-label={pluginName(manifest, t)}
      className="h-full w-72 max-w-[55%] shrink-0 overflow-auto border-r border-(--mint-border) bg-(--mint-sidebar-bg) p-2 text-sm"
    >
      <h2 className="mb-2 font-semibold">{pluginName(manifest, t)}</h2>
      {!granted ? (
        <p role="alert">{t("plugin.folderDenied")}</p>
      ) : !folder ? (
        <p>{t("tasks.needFolder")}</p>
      ) : failed ? (
        <p role="alert">{t("plugin.folderError")}</p>
      ) : !tasks ? (
        <p>{t("search.searching")}</p>
      ) : tasks.length === 0 ? (
        <p>{t("tasks.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map(({ path, location, checked, label }) => (
            <li key={JSON.stringify([path, location.line])}>
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left hover:bg-(--mint-hover)"
                onClick={() => {
                  if (canReadFolder(manifest.id))
                    onOpen(path, { ...location, lineEndings: "markdown" });
                }}
              >
                <span className="block break-words">{label}</span>
                <small className="block break-all">
                  {t(checked ? "tasks.completed" : "tasks.todo")} · {relativePath(folder, path)}:
                  {location.line}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

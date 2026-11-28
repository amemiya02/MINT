import { stringify } from "yaml";
import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import type { FolderViewProps } from "./folder-documents.ts";
import { useFolderProperties } from "./folder-properties.ts";
import { canReadFolder } from "./host.ts";
import { pluginName } from "./Plugins.tsx";

function propertyText(value: unknown): string {
  return typeof value === "object" && value !== null
    ? stringify(value, { collectionStyle: "flow", lineWidth: 0 }).trimEnd()
    : String(value);
}

export function PropertyTable(props: FolderViewProps) {
  const { manifest, folder, granted, onOpen } = props;
  const { documents, failed } = useFolderProperties(props);
  const t = useT();
  const columns = [...new Set(documents?.flatMap((d) => Object.keys(d.properties)))].sort((a, b) =>
    a.localeCompare(b),
  );
  return (
    <aside
      aria-label={pluginName(manifest, t)}
      className="h-full w-96 max-w-[55%] shrink-0 overflow-auto border-r border-(--mint-border) bg-(--mint-sidebar-bg) p-2 text-sm"
    >
      <h2 className="mb-2 font-semibold">{pluginName(manifest, t)}</h2>
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
        <table className="w-full border-collapse text-left [&_td]:border [&_th]:border [&_th]:border-(--mint-border) [&_td]:border-(--mint-border) [&_td]:px-2 [&_th]:px-2">
          <thead>
            <tr>
              <th scope="col">{t("plugin.documentColumn")}</th>
              {columns.map((k) => (
                <th key={k} scope="col">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {documents.map(({ path, properties }) => (
              <tr key={path}>
                <th scope="row">
                  <button
                    type="button"
                    className="break-all py-1 text-left underline"
                    onClick={() => {
                      if (canReadFolder(manifest.id)) onOpen(path);
                    }}
                  >
                    {relativePath(folder, path)}
                  </button>
                </th>
                {columns.map((k) => (
                  <td key={k}>
                    {Object.hasOwn(properties, k) ? propertyText(properties[k]) : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </aside>
  );
}

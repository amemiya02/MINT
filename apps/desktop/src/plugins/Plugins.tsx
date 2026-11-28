import type { WordCount } from "@mint/editor";
import { useEffect, useState } from "react";
import { type Translate, useT } from "../i18n/index.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import {
  addedPermissions,
  change,
  epubExport,
  install,
  installations,
  isManifest,
  notionImporter,
  type Permission,
  type PluginManifest,
  propertyTable,
  readStatistics,
  tagBrowser,
  timingDiagrams,
  uninstall,
  update,
  writingStatistics,
  writingTemplates,
} from "./host.ts";

export function useInstallations() {
  const [items, setItems] = useState(installations);
  useEffect(() => {
    const refresh = () => setItems(installations());
    window.addEventListener("mint-plugin-change", refresh);
    window.addEventListener("storage", refresh);
    refresh();
    return () => {
      window.removeEventListener("mint-plugin-change", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return items;
}

const button = "rounded border border-(--mint-border) px-2 py-1 text-sm hover:bg-(--mint-hover)";
export function pluginName(m: PluginManifest, t: Translate) {
  if (m.id === notionImporter.id) return t("notion.name");
  if (m.id === epubExport.id) return t("plugin.epub");
  if (m.id === timingDiagrams.id) return t("plugin.timing");
  if (m.id === writingTemplates.id) return t("plugin.templates");
  if (m.id === propertyTable.id) return t("plugin.properties");
  if (m.id === tagBrowser.id) return t("plugin.tags");
  return m.id === writingStatistics.id ? t("plugin.statistics") : m.name;
}

function permission(action: Permission, t: Translate) {
  if (action === "archive.import") return t("notion.permission");
  if (action === "document.write") return t("plugin.write");
  return t(action === "folder.read" ? "plugin.folderRead" : "plugin.read");
}

export function PluginSettings() {
  const t = useT();
  const installed = useInstallations();
  const [pending, setPending] = useState<PluginManifest | null>(null);
  const [review, setReview] = useState<{ manifest: PluginManifest; added: Permission[] } | null>(
    null,
  );
  const [invalidFile, setInvalidFile] = useState(false);
  const [failed, setFailed] = useState(false);
  function apply(action: () => void) {
    try {
      action();
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  const available = [
    writingStatistics,
    writingTemplates,
    tagBrowser,
    propertyTable,
    timingDiagrams,
    notionImporter,
    epubExport,
  ].filter((m) => !installed.some((i) => i.manifest.id === m.id));
  return (
    <section aria-label={t("plugin.title")} className="flex flex-col gap-2">
      <h3 className="font-medium">{t("plugin.title")}</h3>
      {available.map((m) => (
        <fieldset
          aria-label={pluginName(m, t)}
          key={m.id}
          className="flex items-center justify-between"
        >
          {pluginName(m, t)}{" "}
          <button
            type="button"
            className={button}
            aria-label={m.id === writingTemplates.id ? t("plugin.installTemplates") : undefined}
            onClick={() => {
              setReview(null);
              setPending(m);
            }}
          >
            {t("plugin.install")}
          </button>
        </fieldset>
      ))}
      <label className="flex flex-col gap-1 text-sm">
        {t("plugin.file")}
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            setPending(null);
            setReview(null);
            try {
              const manifest: unknown = file.size <= 65536 && JSON.parse(await file.text());
              if (!isManifest(manifest) || manifest.id.startsWith("mint.")) {
                setInvalidFile(true);
                return;
              }
              const current = installations().find((i) => i.manifest.id === manifest.id);
              if (current) {
                const added = addedPermissions(current.manifest, manifest);
                if (added.length) setReview({ manifest, added });
                else apply(() => update(manifest));
              } else setPending(manifest);
              setInvalidFile(false);
            } catch {
              setInvalidFile(true);
            }
          }}
        />
      </label>
      {invalidFile && <p role="alert">{t("plugin.invalid")}</p>}
      {pending && (
        <div className="rounded border border-(--mint-border) p-2">
          <strong>{pluginName(pending, t)}</strong>
          {pending.permissions.map((p) => (
            <p key={p}>{permission(p, t)}</p>
          ))}
          <div className="flex gap-2">
            {([true, false] as const).map((grant) => (
              <button
                type="button"
                className={button}
                key={String(grant)}
                onClick={() =>
                  apply(() => {
                    install(pending, grant);
                    setPending(null);
                  })
                }
              >
                {t(grant ? "plugin.allow" : "plugin.deny")}
              </button>
            ))}
          </div>
        </div>
      )}
      {review && (
        <fieldset className="rounded border border-(--mint-border) p-2">
          <legend>{t("plugin.update", { name: pluginName(review.manifest, t) })}</legend>
          {review.added.map((p) => (
            <p key={p}>{permission(p, t)}</p>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              className={button}
              onClick={() =>
                apply(() => {
                  update(review.manifest, review.added);
                  setReview(null);
                })
              }
            >
              {t("plugin.allowUpdate")}
            </button>
            <button type="button" className={button} onClick={() => setReview(null)}>
              {t("plugin.keep")}
            </button>
          </div>
        </fieldset>
      )}
      {installed.map((i) => (
        <fieldset
          aria-label={pluginName(i.manifest, t)}
          key={i.manifest.id}
          className="flex flex-col gap-1"
        >
          <span>{pluginName(i.manifest, t)}</span>
          {i.manifest.permissions.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <small>{permission(p, t)}</small>
              <button
                type="button"
                className={button}
                onClick={() =>
                  apply(() =>
                    change(i.manifest.id, { permission: p, granted: !i.grants.includes(p) }),
                  )
                }
              >
                {t(i.grants.includes(p) ? "plugin.revoke" : "plugin.allow")}
              </button>
            </div>
          ))}
          {"diagram" in i.manifest && (
            <details className="text-sm">
              <summary className="cursor-pointer">{t("plugin.exampleMarkdown")}</summary>
              <pre className="select-all">
                {["```timing", "CLK: 0101", "ACK: 0011", "```"].join("\n")}
              </pre>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              onClick={() => apply(() => change(i.manifest.id, { enabled: !i.enabled }))}
            >
              {t(i.enabled ? "plugin.disable" : "plugin.enable")}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => apply(() => uninstall(i.manifest.id))}
            >
              {t("plugin.uninstall")}
            </button>
          </div>
        </fieldset>
      ))}
      {failed && <p role="alert">{t("plugin.failed")}</p>}
    </section>
  );
}

export function PluginEntries({ readDocument }: { readDocument: () => WordCount | null }) {
  const t = useT();
  const items = useInstallations().filter((i) => i.enabled && "statistics" in i.manifest);
  if (items.length === 0) return null;
  return (
    <nav
      aria-label={t("plugin.title")}
      className="flex gap-2 border-t border-(--mint-border) px-4 py-1"
    >
      {items.map((i) => (
        <PluginEntry key={i.manifest.id} manifest={i.manifest} readDocument={readDocument} />
      ))}
    </nav>
  );
}

interface DocumentViewProps {
  manifest: PluginManifest;
  readDocument: () => WordCount | null;
}

function PluginEntry({ manifest, readDocument }: DocumentViewProps) {
  const t = useT();
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button type="button" className={button} onClick={() => setOpened(true)}>
        {pluginName(manifest, t)}
      </button>
      {opened && (
        <PluginView
          manifest={manifest}
          readDocument={readDocument}
          onClose={() => setOpened(false)}
        />
      )}
    </>
  );
}

function PluginView({
  manifest,
  readDocument,
  onClose,
}: DocumentViewProps & { onClose: () => void }) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const result = readStatistics(manifest.id, readDocument);
  return (
    <dialog
      {...props}
      aria-label={pluginName(manifest, t)}
      className="m-auto rounded border border-(--mint-border) bg-(--mint-bg) p-5 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <h2 className="mb-2 font-medium">{pluginName(manifest, t)}</h2>
      {result.status === "denied" ? (
        <p role="alert">{t("plugin.denied")}</p>
      ) : result.status === "empty" ? (
        <p>{t("plugin.empty")}</p>
      ) : (
        result.rows.map((row) => (
          <p key={row.metric}>{t(`plugin.${row.metric}`, { count: String(row.value) })}</p>
        ))
      )}
      <button type="button" className={button} onClick={close}>
        {t("settings.close")}
      </button>
    </dialog>
  );
}

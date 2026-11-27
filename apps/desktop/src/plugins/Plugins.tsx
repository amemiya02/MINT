import type { WordCount } from "@mint/editor";
import { useEffect, useState } from "react";
import { type Translate, useT } from "../i18n/index.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import {
  change,
  install,
  installations,
  isManifest,
  type PluginManifest,
  readStatistics,
  uninstall,
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
function name(m: PluginManifest, t: Translate) {
  if (m.id === writingTemplates.id) return t("plugin.templates");
  return m.id === writingStatistics.id ? t("plugin.statistics") : m.name;
}

export function PluginSettings() {
  const t = useT();
  const installed = useInstallations();
  const [pending, setPending] = useState<PluginManifest | null>(null);
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
  const available = [writingStatistics, writingTemplates].filter(
    (m) => !installed.some((i) => i.manifest.id === m.id),
  );
  return (
    <section aria-label={t("plugin.title")} className="flex flex-col gap-2">
      <h3 className="font-medium">{t("plugin.title")}</h3>
      {available.map((m) => (
        <div key={m.id} className="flex items-center justify-between">
          {name(m, t)}{" "}
          <button
            type="button"
            className={button}
            aria-label={m.id === writingTemplates.id ? t("plugin.installTemplates") : undefined}
            onClick={() => setPending(m)}
          >
            {t("plugin.install")}
          </button>
        </div>
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
            try {
              const manifest: unknown = file.size <= 65536 && JSON.parse(await file.text());
              if (
                !isManifest(manifest) ||
                manifest.id.startsWith("mint.") ||
                installed.some((i) => i.manifest.id === manifest.id)
              ) {
                setInvalidFile(true);
                return;
              }
              setPending(manifest);
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
          <strong>{name(pending, t)}</strong>
          <p>{t("templates" in pending ? "plugin.write" : "plugin.read")}</p>
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
      {installed.map((i) => (
        <div key={i.manifest.id} className="flex flex-col gap-1">
          <span>{name(i.manifest, t)}</span>
          <small>{t("templates" in i.manifest ? "plugin.write" : "plugin.read")}</small>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              onClick={() => apply(() => change(i.manifest.id, { granted: !i.granted }))}
            >
              {t(i.granted ? "plugin.revoke" : "plugin.allow")}
            </button>
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
        </div>
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
        {name(manifest, t)}
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
      aria-label={name(manifest, t)}
      className="m-auto rounded border border-(--mint-border) bg-(--mint-bg) p-5 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <h2 className="mb-2 font-medium">{name(manifest, t)}</h2>
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

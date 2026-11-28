import { useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { canImportArchive } from "./host.ts";
import type { importNotion } from "./notion-import.ts";

interface Props {
  id: string;
  platform: Platform;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onOpenFolder: (folder: string) => Promise<void>;
}
const button =
  "rounded border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) disabled:opacity-50";

export function NotionImport({ id, platform, busy, setBusy, onOpenFolder }: Props) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof importNotion>> | null>(null);
  const [error, setError] = useState("");
  async function run() {
    if (!file || !canImportArchive(id)) return;
    setBusy(true);
    setError("");
    try {
      const parent = await platform.showOpenFolderDialog({ title: t("notion.destination") });
      if (!parent) return;
      const { importNotion } = await import("./notion-import.ts");
      setResult(await importNotion(platform, id, file, parent, name, t));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!canImportArchive(id)) return <p role="alert">{t("notion.denied")}</p>;
  if (result)
    return (
      <>
        <p role="status">{t("notion.complete", { path: result.destination })}</p>
        {result.issues.length > 0 && (
          <section>
            <h3>{t("notion.report", { name: result.report })}</h3>
            <ul className="max-h-52 overflow-auto break-words">
              {result.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </section>
        )}
        <button
          type="button"
          className={button}
          onClick={() => void onOpenFolder(result.destination)}
        >
          {t("notion.open")}
        </button>
      </>
    );
  return (
    <>
      <label className="grid gap-1">
        {t("notion.archive")}
        <input
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(e) => {
            const archive = e.target.files?.[0] ?? null;
            setFile(archive);
            setName(archive?.name.replace(/\.zip$/i, "") ?? "");
            setError("");
          }}
        />
      </label>
      <label className="grid gap-1">
        {t("notion.folder")}
        <input
          className="rounded border border-(--mint-border) px-2 py-1"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !file || !name.trim()}
        className={button}
        onClick={() => void run()}
      >
        {t(busy ? "notion.busy" : "notion.submit")}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

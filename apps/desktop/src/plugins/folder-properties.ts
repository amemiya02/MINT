import { useEffect, useState } from "react";
import { parse } from "yaml";
import { documentExtensions } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { canReadFolder, type PluginManifest } from "./host.ts";

export interface FolderViewProps {
  manifest: PluginManifest;
  granted: boolean;
  folder: string | null;
  platform: Platform;
  onOpen: (path: string) => void;
}

export interface FolderDocument {
  path: string;
  properties: Record<string, unknown>;
}

export function propertiesOf(source: string): Record<string, unknown> {
  if (!source.startsWith("---") && !source.startsWith("\uFEFF---")) return {};
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*\r?$/m.exec(source);
  if (header?.index !== 0) return {};
  try {
    const values = parse(header[1] ?? "");
    if (values && typeof values === "object" && !Array.isArray(values)) return values;
  } catch {
    // Malformed front matter still belongs to a browsable document.
  }
  return {};
}

async function readDocuments(id: string, folder: string, platform: Platform, signal: AbortSignal) {
  const allowed = () => !signal.aborted && canReadFolder(id);
  const documents: FolderDocument[] = [];
  if (!allowed()) return documents;
  for (const path of await platform.listFolderFiles(folder, documentExtensions)) {
    if (!allowed()) break;
    try {
      documents.push({ path, properties: propertiesOf(await platform.readTextFile(path)) });
    } catch {
      // A document may have disappeared since the walk or contain invalid UTF-8.
    }
  }
  return documents;
}

// The shell keys each view by plugin, folder and grant, clearing prior results on change.
export function useFolderProperties(
  { manifest, folder, platform, granted }: FolderViewProps,
  revision = 0,
) {
  const [documents, setDocuments] = useState<FolderDocument[] | null>(null);
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A move refreshes the on-disk snapshot.
  useEffect(() => {
    if (!folder || !granted) return;
    setFailed(false);
    const controller = new AbortController();
    readDocuments(manifest.id, folder, platform, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted && canReadFolder(manifest.id)) setDocuments(result);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [manifest.id, folder, granted, platform, revision]);
  return { documents, failed };
}

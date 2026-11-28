import { useEffect, useState } from "react";
import { documentExtensions } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import type { DocumentLocation } from "../tabs/tab-store.ts";
import { canReadFolder, type PluginManifest } from "./host.ts";

export interface FolderViewProps {
  manifest: PluginManifest;
  granted: boolean;
  folder: string | null;
  platform: Platform;
  onOpen: (path: string, location?: DocumentLocation) => void;
}

async function readDocuments<T>(
  id: string,
  folder: string,
  platform: Platform,
  signal: AbortSignal,
  project: (path: string, source: string) => T,
) {
  const allowed = () => !signal.aborted && canReadFolder(id);
  const documents: T[] = [];
  if (!allowed()) return documents;
  for (const path of await platform.listFolderFiles(folder, documentExtensions)) {
    if (!allowed()) break;
    let source: string;
    try {
      source = await platform.readTextFile(path);
    } catch {
      // A document may have disappeared since the walk or contain invalid UTF-8.
      continue;
    }
    if (!allowed()) break;
    documents.push(project(path, source));
  }
  return documents;
}

// The shell keys each view by plugin, folder and grant, clearing prior results on change.
export function useFolderDocuments<T>(
  { manifest, folder, platform, granted }: FolderViewProps,
  project: (path: string, source: string) => T,
  revision?: unknown,
) {
  const [documents, setDocuments] = useState<T[] | null>(null);
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changes to the revision refresh the on-disk snapshot.
  useEffect(() => {
    if (!folder || !granted) return;
    setFailed(false);
    const controller = new AbortController();
    readDocuments(manifest.id, folder, platform, controller.signal, project).then(
      (result) => {
        if (!controller.signal.aborted && canReadFolder(manifest.id)) setDocuments(result);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [manifest.id, folder, granted, platform, project, revision]);
  return { documents, failed };
}

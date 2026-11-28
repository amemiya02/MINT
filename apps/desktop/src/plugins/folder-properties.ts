import { parse } from "yaml";
import { type FolderViewProps, useFolderDocuments } from "./folder-documents.ts";

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

function documentProperties(path: string, source: string): FolderDocument {
  return { path, properties: propertiesOf(source) };
}

export function useFolderProperties(props: FolderViewProps, revision = 0) {
  return useFolderDocuments(props, documentProperties, revision);
}

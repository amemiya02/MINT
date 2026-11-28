import type { WordCount } from "@mint/editor";

/** A declarative MINT document view. Packages select host operations and never execute script. */
interface ManifestBase {
  apiVersion: 1;
  id: string;
  name: string;
}

interface StatisticsManifest extends ManifestBase {
  permissions: ["document.read"];
  statistics: (keyof WordCount)[];
}

interface TemplatesManifest extends ManifestBase {
  permissions: ["document.write"];
  templates: { name: string; text: string }[];
}

interface SidebarManifest extends ManifestBase {
  permissions: ["folder.read"];
  sidebar: "tags";
}

interface DiagramManifest extends ManifestBase {
  permissions: ["document.read"];
  diagram: "timing";
}

interface ImportManifest extends ManifestBase {
  permissions: ["archive.import"];
  importer: "notion";
}

export const notionImporter: ImportManifest = {
  apiVersion: 1,
  id: "mint.notion-import",
  name: "Notion import",
  permissions: ["archive.import"],
  importer: "notion",
};

export type PluginManifest =
  | ImportManifest
  | StatisticsManifest
  | TemplatesManifest
  | SidebarManifest
  | DiagramManifest;

export const timingDiagrams: DiagramManifest = {
  apiVersion: 1,
  id: "mint.timing-diagrams",
  name: "Digital timing diagrams",
  permissions: ["document.read"],
  diagram: "timing",
};

export const tagBrowser: SidebarManifest = {
  apiVersion: 1,
  id: "mint.tag-browser",
  name: "Tag browser",
  permissions: ["folder.read"],
  sidebar: "tags",
};

export const writingTemplates: TemplatesManifest = {
  apiVersion: 1,
  id: "mint.writing-templates",
  name: "Writing templates",
  permissions: ["document.write"],
  templates: [
    { name: "Meeting notes", text: "## Meeting notes\n\n- " },
    { name: "Checklist", text: "- [ ] " },
  ],
};

export const writingStatistics: StatisticsManifest = {
  apiVersion: 1,
  id: "mint.writing-statistics",
  name: "Writing statistics",
  permissions: ["document.read"],
  statistics: ["words", "characters", "readingMinutes"],
};

interface Installation {
  manifest: PluginManifest;
  enabled: boolean;
  granted: boolean;
}

const prefix = "mint.plugin.v1.";
const metrics = new Set(["words", "characters", "readingMinutes"]);

function isTemplate(value: unknown): value is TemplatesManifest["templates"][number] {
  if (!value || typeof value !== "object") return false;
  return (
    "name" in value &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    "text" in value &&
    typeof value.text === "string" &&
    value.text.length > 0
  );
}

export function isManifest(value: unknown): value is PluginManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<
    ManifestBase & { permissions: unknown[]; statistics: unknown[]; templates: unknown[] }
  >;
  if (
    m.apiVersion !== 1 ||
    typeof m.id !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(m.id) ||
    typeof m.name !== "string" ||
    !m.name.trim() ||
    m.name.length > 120 ||
    !Array.isArray(m.permissions) ||
    m.permissions.length !== 1
  )
    return false;
  if ("importer" in m) {
    return (
      m.importer === "notion" &&
      m.permissions[0] === "archive.import" &&
      !["diagram", "sidebar", "statistics", "templates"].some((key) => key in m)
    );
  }
  if ("diagram" in m) {
    return (
      m.diagram === "timing" &&
      m.permissions[0] === "document.read" &&
      !("sidebar" in m) &&
      !("statistics" in m) &&
      !("templates" in m)
    );
  }
  if ("sidebar" in m) {
    return (
      m.sidebar === "tags" &&
      m.permissions[0] === "folder.read" &&
      !("statistics" in m) &&
      !("templates" in m)
    );
  }
  if (m.permissions[0] === "document.write") {
    return (
      !("statistics" in m) &&
      Array.isArray(m.templates) &&
      m.templates.length > 0 &&
      m.templates.every(isTemplate) &&
      new Set(m.templates.map((item) => item.name)).size === m.templates.length
    );
  }
  return (
    m.permissions[0] === "document.read" &&
    !("templates" in m) &&
    Array.isArray(m.statistics) &&
    m.statistics.length > 0 &&
    m.statistics.length <= metrics.size &&
    new Set(m.statistics).size === m.statistics.length &&
    m.statistics.every((metric) => typeof metric === "string" && metrics.has(metric))
  );
}

function installed(id: string): Installation | null {
  try {
    const item = JSON.parse(localStorage.getItem(prefix + id) ?? "null");
    if (
      item &&
      isManifest(item.manifest) &&
      item.manifest.id === id &&
      typeof item.enabled === "boolean" &&
      typeof item.granted === "boolean"
    )
      return item;
  } catch {
    /* An unreadable installation has no capabilities. */
  }
  return null;
}

export function installations(): Installation[] {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix))
    .sort()
    .flatMap((key) => installed(key.slice(prefix.length)) ?? []);
}

function persist(item: Installation) {
  localStorage.setItem(prefix + item.manifest.id, JSON.stringify(item));
  window.dispatchEvent(new Event("mint-plugin-change"));
}

export function install(manifest: PluginManifest, granted: boolean) {
  if (!isManifest(manifest) || installed(manifest.id))
    throw new Error("Invalid or installed plugin");
  persist({ manifest, enabled: true, granted });
}

export function change(id: string, change: { enabled: boolean } | { granted: boolean }) {
  const item = installed(id);
  if (item) persist({ ...item, ...change });
}

export function uninstall(id: string) {
  localStorage.removeItem(prefix + id);
  window.dispatchEvent(new Event("mint-plugin-change"));
}

export function readStatistics(id: string, readDocument: () => WordCount | null) {
  const item = installed(id);
  if (!item?.enabled || !item.granted || !("statistics" in item.manifest))
    return { status: "denied" } as const;
  const counts = readDocument();
  if (!counts) return { status: "empty" } as const;
  return {
    status: "ok",
    rows: item.manifest.statistics.map((metric) => ({ metric, value: counts[metric] })),
  } as const;
}

/** Resolve the live grant and installed template again when the writer runs its command. */
export function insertTemplate(id: string, name: string, insert: (text: string) => boolean) {
  const item = installed(id);
  if (!item?.enabled || !item.granted || !("templates" in item.manifest)) return "denied";
  const template = item.manifest.templates.find((t) => t.name === name);
  if (!template) return "denied";
  return insert(template.text) ? "ok" : "empty";
}

export function canReadFolder(id: string): boolean {
  const item = installed(id);
  return Boolean(item?.enabled && item.granted && "sidebar" in item.manifest);
}

export function canImportArchive(id: string): boolean {
  const item = installed(id);
  return Boolean(item?.enabled && item.granted && "importer" in item.manifest);
}

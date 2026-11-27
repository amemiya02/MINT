import type { WordCount } from "@mint/editor";

/** A declarative MINT document view. Packages select host operations and never execute script. */
interface BaseManifest {
  apiVersion: 1;
  id: string;
  name: string;
}

export interface StatisticsManifest extends BaseManifest {
  permissions: ["document.read"];
  statistics: (keyof WordCount)[];
}

export interface SidebarManifest extends BaseManifest {
  permissions: ["folder.read"];
  sidebar: "tags";
}

export type PluginManifest = StatisticsManifest | SidebarManifest;

export const tagBrowser: SidebarManifest = {
  apiVersion: 1,
  id: "mint.tag-browser",
  name: "Tag browser",
  permissions: ["folder.read"],
  sidebar: "tags",
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

export function isManifest(value: unknown): value is PluginManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
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
  if ("sidebar" in m)
    return m.sidebar === "tags" && m.permissions[0] === "folder.read" && !("statistics" in m);
  return (
    m.permissions[0] === "document.read" &&
    Array.isArray(m.statistics) &&
    m.statistics.length > 0 &&
    m.statistics.length <= metrics.size &&
    new Set(m.statistics).size === m.statistics.length &&
    m.statistics.every((metric) => metrics.has(metric))
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

export function canReadFolder(id: string): boolean {
  const item = installed(id);
  return Boolean(item?.enabled && item.granted && "sidebar" in item.manifest);
}

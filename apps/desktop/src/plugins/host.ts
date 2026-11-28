import type { WordCount } from "@mint/editor";

import { isPluginFormat, type PluginFormat } from "./export-formats.ts";

export type Permission = "document.read" | "document.write" | "folder.read";

/** Packages declare the host operations they use. */
export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  permissions: Permission[];
  statistics?: (keyof WordCount)[];
  templates?: { name: string; text: string }[];
  exportFormat?: PluginFormat;
  sidebar?: "tags";
  diagram?: "timing";
}

export const epubExport: PluginManifest = {
  apiVersion: 1,
  id: "mint.epub-export",
  name: "EPUB export",
  permissions: ["document.read"],
  exportFormat: "epub",
};

export const timingDiagrams: PluginManifest = {
  apiVersion: 1,
  id: "mint.timing-diagrams",
  name: "Digital timing diagrams",
  permissions: ["document.read"],
  diagram: "timing",
};

export const tagBrowser: PluginManifest = {
  apiVersion: 1,
  id: "mint.tag-browser",
  name: "Tag browser",
  permissions: ["folder.read"],
  sidebar: "tags",
};

export const writingTemplates: PluginManifest = {
  apiVersion: 1,
  id: "mint.writing-templates",
  name: "Writing templates",
  permissions: ["document.write"],
  templates: [
    { name: "Meeting notes", text: "## Meeting notes\n\n- " },
    { name: "Checklist", text: "- [ ] " },
  ],
};

export const writingStatistics: PluginManifest = {
  apiVersion: 1,
  id: "mint.writing-statistics",
  name: "Writing statistics",
  permissions: ["document.read"],
  statistics: ["words", "characters", "readingMinutes"],
};

interface Installation {
  manifest: PluginManifest;
  enabled: boolean;
  grants: Permission[];
}

const prefix = "mint.plugin.v1.";
const metrics = new Set(["words", "characters", "readingMinutes"]);

function isTemplate(value: unknown): value is NonNullable<PluginManifest["templates"]>[number] {
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
  const m = value as Record<string, unknown>;
  if (
    m.apiVersion !== 1 ||
    typeof m.id !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(m.id) ||
    typeof m.name !== "string" ||
    !m.name.trim() ||
    m.name.length > 120 ||
    !Array.isArray(m.permissions) ||
    m.permissions.length === 0
  )
    return false;
  const required = new Set<Permission>();
  if ("exportFormat" in m) {
    if (!isPluginFormat(m.exportFormat)) return false;
    required.add("document.read");
  }
  if ("diagram" in m) {
    if (m.diagram !== "timing") return false;
    required.add("document.read");
  }
  if ("sidebar" in m) {
    if (m.sidebar !== "tags") return false;
    required.add("folder.read");
  }
  if ("statistics" in m) {
    if (
      !Array.isArray(m.statistics) ||
      !m.statistics.length ||
      new Set(m.statistics).size !== m.statistics.length ||
      !m.statistics.every((metric) => metrics.has(metric))
    )
      return false;
    required.add("document.read");
  }
  if ("templates" in m) {
    if (
      !Array.isArray(m.templates) ||
      !m.templates.length ||
      !m.templates.every(isTemplate) ||
      new Set(m.templates.map((item) => item.name)).size !== m.templates.length
    )
      return false;
    required.add("document.write");
  }
  const permissions = m.permissions;
  return (
    permissions.length === required.size && [...required].every((p) => permissions.includes(p))
  );
}

function installed(id: string): Installation | null {
  try {
    const item = JSON.parse(localStorage.getItem(prefix + id) ?? "null");
    if (
      item &&
      isManifest(item.manifest) &&
      item.manifest.id === id &&
      typeof item.enabled === "boolean"
    ) {
      const { manifest, enabled } = item;
      if (Array.isArray(item.grants))
        return {
          manifest,
          enabled,
          grants: manifest.permissions.filter((p: Permission) => item.grants.includes(p)),
        };
      // Older packages had exactly one operation, controlled by a boolean grant.
      if (typeof item.granted === "boolean" && manifest.permissions.length === 1)
        return { manifest, enabled, grants: item.granted ? manifest.permissions : [] };
    }
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
  persist({ manifest, enabled: true, grants: granted ? manifest.permissions : [] });
}

export function addedPermissions(current: PluginManifest, next: PluginManifest) {
  return next.permissions.filter((p) => !current.permissions.includes(p));
}

export function update(manifest: PluginManifest, approved: Permission[] = []) {
  const item = installed(manifest.id);
  if (!item || !isManifest(manifest)) throw new Error("Invalid plugin update");
  const added = addedPermissions(item.manifest, manifest);
  if (added.some((p) => !approved.includes(p)))
    throw new Error("Update requires permission review");
  const grants = manifest.permissions.filter((p) => item.grants.includes(p) || added.includes(p));
  persist({ manifest, enabled: item.enabled, grants });
}

export function change(
  id: string,
  change: { enabled: boolean } | { permission: Permission; granted: boolean },
) {
  const item = installed(id);
  if (!item) return;
  if ("enabled" in change) persist({ ...item, enabled: change.enabled });
  else {
    const grants = item.manifest.permissions.filter((p) =>
      p === change.permission ? change.granted : item.grants.includes(p),
    );
    persist({ ...item, grants });
  }
}

export function uninstall(id: string) {
  localStorage.removeItem(prefix + id);
  window.dispatchEvent(new Event("mint-plugin-change"));
}

export function readStatistics(id: string, readDocument: () => WordCount | null) {
  const item = installed(id);
  if (!item?.enabled || !item.grants.includes("document.read") || !item.manifest.statistics)
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
  if (!item?.enabled || !item.grants.includes("document.write") || !item.manifest.templates)
    return "denied";
  const template = item.manifest.templates.find((t) => t.name === name);
  if (!template) return "denied";
  return insert(template.text) ? "ok" : "empty";
}

export function canReadFolder(id: string): boolean {
  const item = installed(id);
  return Boolean(
    item?.enabled && item.grants.includes("folder.read") && "sidebar" in item.manifest,
  );
}

export function activeExportFormats(items = installations()): PluginFormat[] {
  return [
    ...new Set(
      items.flatMap(({ manifest, enabled, grants }) =>
        enabled && grants.includes("document.read") && manifest.exportFormat
          ? [manifest.exportFormat]
          : [],
      ),
    ),
  ];
}

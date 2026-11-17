import { useState } from "react";
import { type Translate, useT } from "../i18n/index.ts";
import { type SettingDefinition, settingsSchema } from "./schema.ts";
import type { SettingsIssue } from "./settings.ts";
import { useSettings } from "./useSettings.ts";

/** Problems with settings.json, shown until the file changes again or the user dismisses them. */
export function SettingsIssues() {
  const t = useT();
  const { issues } = useSettings();
  const [dismissed, setDismissed] = useState<readonly SettingsIssue[] | null>(null);
  if (issues.length === 0 || issues === dismissed) return null;

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
    >
      <ul className="flex flex-col gap-0.5">
        {issues.map((issue) => (
          <li key={`${issue.kind}:${"key" in issue ? issue.key : ""}`}>
            {describeIssue(issue, t)}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setDismissed(issues)}
        className="shrink-0 rounded px-2 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
      >
        {t("settings.dismiss")}
      </button>
    </div>
  );
}

function describeIssue(issue: SettingsIssue, t: Translate): string {
  switch (issue.kind) {
    case "unreadable":
      return t("settings.issue.unreadable", { reason: issue.reason });
    case "invalidValue":
      return t("settings.issue.invalidValue", {
        key: issue.key,
        expected: describeExpected(settingsSchema[issue.key], t),
      });
    case "unknownKey":
      return t("settings.issue.unknownKey", { key: issue.key });
    case "writeFailed":
      return t("settings.issue.writeFailed", { reason: issue.reason });
  }
}

function describeExpected(definition: SettingDefinition, t: Translate): string {
  switch (definition.kind) {
    case "choice":
      return t("settings.expected.oneOf", {
        values: definition.options.map((o) => JSON.stringify(o.value)).join(", "),
      });
    case "toggle":
      return t("settings.expected.toggle");
    case "number":
      return t("settings.expected.number", {
        min: String(definition.min),
        max: String(definition.max),
      });
    case "text":
      return t("settings.expected.text", { max: String(definition.maxLength) });
    case "shortcuts":
      return t("settings.expected.shortcuts");
  }
}

import { useState } from "react";
import { useT } from "../i18n/index.ts";
import type { ThemeIssue as Issue } from "./theme.ts";
import { useTheme } from "./useTheme.ts";

/** Why the chosen user theme is not in use, shown until that changes or the user dismisses it. */
export function ThemeIssue() {
  const t = useT();
  const { issue, folder } = useTheme();
  const [dismissed, setDismissed] = useState<Issue | null>(null);
  if (!issue || issue === dismissed) return null;

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
    >
      <span>
        {issue.kind === "missing"
          ? t("theme.issue.missing", { name: issue.name, path: folder })
          : t("theme.issue.unreadable", { name: issue.name, reason: issue.reason })}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(issue)}
        className="shrink-0 rounded px-2 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
      >
        {t("settings.dismiss")}
      </button>
    </div>
  );
}

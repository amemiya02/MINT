import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { AvailableUpdate, Platform } from "../platform/platform.ts";
import { useSettingsStore } from "../settings/useSettings.ts";

/** What the update notice currently shows; `idle` shows nothing. */
export type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "upToDate" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly update: AvailableUpdate }
  | { readonly kind: "installing"; readonly version: string }
  | { readonly kind: "checkFailed"; readonly reason: string }
  | { readonly kind: "installFailed"; readonly version: string; readonly reason: string };

export interface Updates {
  readonly state: UpdateState;
  /** Check now, on the user's request: every outcome is reported. */
  check(): void;
  install(update: AvailableUpdate): void;
  dismiss(): void;
}

/**
 * Update checks for one window. The main window checks once at startup unless
 * the `checkForUpdates` setting is off; that check only speaks up when a new
 * version exists, so being offline never bothers anyone.
 */
export function useUpdates(platform: Platform): Updates {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const settings = useSettingsStore();
  const startupCheck = useRef(false);

  useEffect(() => {
    if (startupCheck.current || !platform.isMainWindow) return;
    startupCheck.current = true;
    if (!settings.getSnapshot().settings.checkForUpdates) return;
    platform.checkForUpdate().then(
      (result) => {
        if (result.status === "available") setState({ kind: "available", update: result.update });
      },
      () => {},
    );
  }, [platform, settings]);

  const check = useCallback(() => {
    platform.checkForUpdate().then(
      (result) =>
        setState(
          result.status === "available"
            ? { kind: "available", update: result.update }
            : { kind: result.status },
        ),
      (error: unknown) => setState({ kind: "checkFailed", reason: reasonOf(error) }),
    );
  }, [platform]);

  const install = useCallback((update: AvailableUpdate) => {
    setState({ kind: "installing", version: update.version });
    update.install().then(
      () => {},
      (error: unknown) =>
        setState({ kind: "installFailed", version: update.version, reason: reasonOf(error) }),
    );
  }, []);

  const dismiss = useCallback(() => setState({ kind: "idle" }), []);

  return { state, check, install, dismiss };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const bar =
  "flex items-center justify-between gap-3 border-b border-(--mint-border) px-4 py-2 text-sm";
const button =
  "shrink-0 rounded px-2 py-0.5 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

/** A bar at the top of the window that reports update checks and offers a new version. */
export function UpdateNotice({ updates }: { readonly updates: Updates }) {
  const t = useT();
  const { state, install, dismiss } = updates;

  switch (state.kind) {
    case "idle":
      return null;
    case "checkFailed":
    case "installFailed":
      return (
        <div role="alert" className={`${bar} bg-(--mint-error-bg) text-(--mint-error-fg)`}>
          <span>
            {state.kind === "checkFailed"
              ? t("update.checkFailed", { reason: state.reason })
              : t("update.installFailed", { version: state.version, reason: state.reason })}
          </span>
          <button type="button" onClick={dismiss} className={button}>
            {t("settings.dismiss")}
          </button>
        </div>
      );
    case "available":
      return (
        <div role="status" className={bar}>
          <span>{t("update.available", { version: state.update.version })}</span>
          <span className="flex gap-1">
            <button
              type="button"
              onClick={() => install(state.update)}
              className={`${button} font-medium text-(--mint-accent)`}
            >
              {t("update.install")}
            </button>
            <button type="button" onClick={dismiss} className={button}>
              {t("update.later")}
            </button>
          </span>
        </div>
      );
    case "installing":
      return (
        <div role="status" className={bar}>
          <span>{t("update.installing", { version: state.version })}</span>
        </div>
      );
    case "upToDate":
    case "unavailable":
      return (
        <div role="status" className={bar}>
          <span>{t(state.kind === "upToDate" ? "update.upToDate" : "update.unavailable")}</span>
          <button type="button" onClick={dismiss} className={button}>
            {t("settings.dismiss")}
          </button>
        </div>
      );
  }
}

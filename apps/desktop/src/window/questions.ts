import type { Translate } from "../i18n/index.ts";
import { documentExtensions } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import type { RecoveryChoice } from "../recovery/recovery.ts";
import { tabName } from "../tabs/tab-name.ts";
import type { Tab } from "../tabs/tab-store.ts";

/** The questions a window asks the user through the platform's dialogs. */

export async function askRestore(
  platform: Platform,
  t: Translate,
  paths: readonly (string | null)[],
): Promise<RecoveryChoice> {
  const answer = await platform.showQuestionDialog({
    title: t("recovery.title"),
    message: t("recovery.message", {
      names: paths
        .map((path) => tabName(t, { path, untitled: null }))
        .join(t("recovery.separator")),
    }),
    yes: t("recovery.restore"),
    no: t("recovery.discard"),
    cancel: t("recovery.later"),
  });
  return answer === "yes" ? "restore" : answer === "no" ? "discard" : "later";
}

export async function askUnsaved(platform: Platform, t: Translate, tab: Tab) {
  const answer = await platform.showQuestionDialog({
    title: t("unsaved.title"),
    message: t("unsaved.message", { name: tabName(t, tab) }),
    yes: t("unsaved.save"),
    no: t("unsaved.discard"),
    cancel: t("unsaved.cancel"),
  });
  return answer === "yes" ? "save" : answer === "no" ? "discard" : "cancel";
}

export async function askSavePath(
  platform: Platform,
  t: Translate,
  tab: Tab,
  knownPaths: string[],
) {
  return platform.showSaveDialog({
    knownPaths,
    title: t("dialog.saveAs.title"),
    defaultPath: tab.path ?? t("dialog.saveAs.defaultName"),
    filters: [{ name: t("dialog.filter.markdown"), extensions: documentExtensions }],
  });
}

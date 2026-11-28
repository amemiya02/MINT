import type { MintEditor } from "@mint/editor";
import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { baseName } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { DocumentDiff } from "../tabs/DocumentDiff.tsx";
import { useModalDialog } from "../window/useModalDialog.ts";

interface Props {
  readonly editor: MintEditor | null;
  readonly path: string;
  readonly platform: Platform;
  readonly onClose: () => void;
}

export function HistoryDialog({ path, platform, editor, onClose }: Props) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const [versions, setVersions] = useState<number[] | null>(null);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [result, setResult] = useState<{ before: string; after: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    platform.listVersions(path).then(
      (ids) => {
        if (!current) return;
        setVersions(ids);
        setFrom(ids.at(-2) ?? ids.at(-1) ?? 0);
        setTo(ids.length > 1 ? (ids.at(-1) ?? 0) : 0);
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [path, platform]);

  useEffect(() => {
    if (!from || !editor) return;
    let current = true;
    setResult(null);
    setError("");
    Promise.all([
      platform.readVersion(path, from),
      to ? platform.readVersion(path, to) : editor.getText(),
    ]).then(
      ([before, after]) => {
        if (current) setResult({ before, after });
      },
      (e: unknown) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [path, platform, from, to, editor]);

  function applyRestore(next: string) {
    if (!props.ref.current?.open) return;
    if (!result || !editor || editor.getText() !== result.after) {
      setError(t("history.stale"));
      return;
    }
    editor.replaceText(next);
    close();
  }

  async function restoreVersion() {
    if (!result || !editor || saving) return;
    if (editor.getText() !== result.after) {
      setError(t("history.stale"));
      return;
    }
    setSaving(true);
    try {
      await platform.recordVersion(path, result.after);
      applyRestore(result.before);
    } catch (e) {
      setError(t("history.backupFailed", { reason: String(e) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      {...props}
      aria-label={t("command.file.history")}
      className="m-auto w-[min(42rem,95vw)] max-h-[85vh] overflow-auto rounded-lg border border-(--mint-border) bg-(--mint-bg) p-5 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <h2 className="text-lg font-medium">
        {t("command.file.history")} · {baseName(path)}
      </h2>
      {versions?.length === 0 && <p>{t("history.empty")}</p>}
      {!!versions?.length && (
        <div className="my-4 flex flex-wrap gap-4">
          {(["from", "to"] as const).map((side) => (
            <label key={side} className="flex flex-col gap-1 text-sm">
              {t(side === "from" ? "history.from" : "history.to")}
              <select
                disabled={saving}
                className="rounded border border-(--mint-border) bg-(--mint-bg) p-1"
                value={side === "from" ? from : to}
                onChange={(e) => (side === "from" ? setFrom : setTo)(Number(e.target.value))}
              >
                {versions.map((id, i) => (
                  <option key={id} value={id}>
                    {t("history.version", {
                      number: String(i + 1),
                      time: new Date(id).toLocaleString(),
                    })}
                  </option>
                ))}
                {side === "to" && <option value={0}>{t("history.current")}</option>}
              </select>
            </label>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {result && <DocumentDiff {...result} onRestore={to || saving ? undefined : applyRestore} />}
      {result && !to && result.before !== result.after && (
        <button
          type="button"
          className="mt-4 mr-2 rounded border border-(--mint-border) px-3 py-1"
          disabled={saving}
          onClick={() => void restoreVersion()}
        >
          {t("history.restoreVersion")}
        </button>
      )}
      <button
        type="button"
        className="mt-4 rounded border border-(--mint-border) px-3 py-1"
        onClick={close}
      >
        {t("history.close")}
      </button>
    </dialog>
  );
}

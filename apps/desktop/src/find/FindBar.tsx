import type { FindQuery, FindStatus, MintEditor } from "@mint/editor";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";

export type FindMode = "find" | "replace";

interface FindBarProps {
  readonly mode: FindMode;
  /** Changes every time find or replace is invoked, so the bar refocuses its field. */
  readonly request: number;
  /** Key of the editor being searched (the active tab); the query follows it across tabs. */
  readonly editorKey: number | null;
  readonly getEditor: () => MintEditor | null;
  readonly onClose: () => void;
}

const noStatus: FindStatus = { total: 0, current: 0, valid: false };

/** Find and replace in the active document. Matching runs in the editor core on the Markdown source. */
export function FindBar({ mode, request, editorKey, getEditor, onClose }: FindBarProps) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [status, setStatus] = useState<FindStatus>(noStatus);
  const searchField = useRef<HTMLInputElement>(null);
  const getEditorRef = useRef(getEditor);
  getEditorRef.current = getEditor;

  // Each invocation focuses the find field, seeded with the selected text if it is a single line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per invocation.
  useEffect(() => {
    const editor = getEditorRef.current();
    if (editor) {
      const { anchor, head } = editor.getSelection();
      const selected = editor.getText().slice(Math.min(anchor, head), Math.max(anchor, head));
      if (selected && !/[\r\n]/.test(selected)) setSearch(selected);
    }
    searchField.current?.focus();
    searchField.current?.select();
  }, [request]);

  // Push the query to the editor and jump to the first match from where the selection starts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorKey re-applies the query to a newly active tab.
  useEffect(() => {
    const editor = getEditorRef.current();
    if (!editor) return;
    const query: FindQuery = { search, replace, caseSensitive, wholeWord, regexp };
    editor.execute("setFindQuery", search ? query : null);
    const { anchor, head } = editor.getSelection();
    editor.setSelection({ anchor: Math.min(anchor, head) });
    editor.execute("findNext");
    setStatus(editor.getFindStatus());
  }, [search, caseSensitive, wholeWord, regexp, editorKey]);

  // The replacement does not move the selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorKey re-applies the query to a newly active tab.
  useEffect(() => {
    const editor = getEditorRef.current();
    if (!editor || !search) return;
    editor.execute("setFindQuery", { search, replace, caseSensitive, wholeWord, regexp });
  }, [replace, editorKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resubscribe when the active tab changes.
  useEffect(() => {
    const editor = getEditorRef.current();
    if (!editor) return;
    setStatus(editor.getFindStatus());
    return editor.subscribe(() => setStatus(editor.getFindStatus()));
  }, [editorKey]);

  // Clear highlights from whichever editor was searched when the bar closes or the tab changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup is keyed on the active tab.
  useEffect(() => {
    const editor = getEditorRef.current();
    return () => {
      editor?.execute("setFindQuery", null);
    };
  }, [editorKey]);

  function run(command: "findNext" | "findPrevious" | "replaceNext" | "replaceAll") {
    const editor = getEditor();
    if (!editor) return;
    editor.execute(command);
    setStatus(editor.getFindStatus());
  }

  function close() {
    onClose();
    getEditor()?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    run(event.shiftKey ? "findPrevious" : "findNext");
  }

  function onReplaceKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    run(event.metaKey || event.ctrlKey ? "replaceAll" : "replaceNext");
  }

  const message = !search
    ? ""
    : !status.valid
      ? t("find.invalid")
      : status.total === 0
        ? t("find.noResults")
        : t("find.count", { current: String(status.current), total: String(status.total) });

  return (
    <search
      aria-label={t("find.label")}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-1.5 border-b border-(--mint-border) bg-(--mint-hover) px-3 py-1.5 text-sm"
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={searchField}
          type="text"
          aria-label={t("find.label")}
          placeholder={t("find.label")}
          aria-invalid={search !== "" && !status.valid}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
          spellCheck={false}
          className={field}
        />
        <Toggle pressed={caseSensitive} onChange={setCaseSensitive} label={t("find.caseSensitive")}>
          Aa
        </Toggle>
        <Toggle pressed={wholeWord} onChange={setWholeWord} label={t("find.wholeWord")}>
          <span className="underline decoration-dotted underline-offset-2">ab</span>
        </Toggle>
        <Toggle pressed={regexp} onChange={setRegexp} label={t("find.regexp")}>
          .*
        </Toggle>
        <output aria-live="polite" className="min-w-24 px-1 text-xs text-(--mint-muted)">
          {message}
        </output>
        <IconButton label={t("find.previous")} onClick={() => run("findPrevious")}>
          ↑
        </IconButton>
        <IconButton label={t("find.next")} onClick={() => run("findNext")}>
          ↓
        </IconButton>
        <IconButton label={t("find.close")} onClick={close}>
          ×
        </IconButton>
      </div>
      {mode === "replace" && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            aria-label={t("find.replaceWith")}
            placeholder={t("find.replaceWith")}
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={onReplaceKeyDown}
            spellCheck={false}
            className={field}
          />
          <TextButton onClick={() => run("replaceNext")} disabled={status.total === 0}>
            {t("find.replace")}
          </TextButton>
          <TextButton onClick={() => run("replaceAll")} disabled={status.total === 0}>
            {t("find.replaceAll")}
          </TextButton>
        </div>
      )}
    </search>
  );
}

const field =
  "w-64 rounded border border-(--mint-border) bg-(--mint-bg) px-2 py-0.5 text-(--mint-fg) outline-none focus:border-(--mint-accent) aria-invalid:border-(--mint-error-fg)";
const button =
  "rounded px-1.5 py-0.5 text-(--mint-muted) hover:bg-(--mint-border) hover:text-(--mint-fg) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-40";

function Toggle(props: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      onClick={() => props.onChange(!props.pressed)}
      className={`${button} font-mono text-xs aria-pressed:bg-(--mint-accent) aria-pressed:text-(--mint-bg)`}
    >
      {props.children}
    </button>
  );
}

function IconButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={button}
    >
      {props.children}
    </button>
  );
}

function TextButton(props: { onClick: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`${button} border border-(--mint-border)`}
    >
      {props.children}
    </button>
  );
}

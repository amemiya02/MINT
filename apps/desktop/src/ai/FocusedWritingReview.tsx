import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";
import type { EditStatus, SavedReviewLink, WritingTasksPlatform } from "./writing-tasks.ts";

interface ReviewBlock {
  readonly kind: "table" | "formula";
  readonly prefix: string;
  readonly suffix: string;
}

export interface ReviewEntry {
  readonly key: string;
  readonly turn: number;
  readonly position: number;
  readonly before: string;
  readonly after: string;
  readonly current: string;
  readonly status: EditStatus;
  readonly note?: string | undefined;
  readonly blocked?: "disk" | "boundaries" | undefined;
  readonly section: { readonly id: string; readonly name: string };
}

const buttonClass =
  "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50";
const selectClass = "min-w-0 rounded border border-(--mint-border) bg-(--mint-bg) px-2 py-1";

const filters = ["pending", "dismissed", "commented", "all"] as const;
type Filter = (typeof filters)[number];

function isPending(entry: ReviewEntry) {
  return entry.status === "preview" && !entry.note;
}

export function FocusedWritingReview({
  entries,
  file,
  path,
  folder,
  tasks,
  onOpenFile,
  initialSelection,
  onSelection,
  onCompare,
  source,
  busy,
  onSource,
  onLocate,
  onDecide,
  onAcceptSection,
  onRestore,
  onComment,
  onClose,
}: {
  readonly entries: readonly ReviewEntry[];
  readonly file: string;
  readonly path: string | null;
  readonly folder: string | null;
  readonly tasks: WritingTasksPlatform;
  readonly onOpenFile: (file: SavedReviewLink) => Promise<boolean>;
  readonly initialSelection: string | undefined;
  readonly onSelection: (key: string | undefined) => void;
  readonly onCompare: (entry: ReviewEntry) => ReviewBlock | null;
  readonly source: boolean;
  readonly busy: boolean;
  readonly onSource: (source: boolean) => void;
  readonly onLocate: (entry: ReviewEntry) => void;
  readonly onDecide: (entry: ReviewEntry, accept: boolean) => Promise<boolean>;
  readonly onAcceptSection: (entries: readonly ReviewEntry[]) => Promise<number>;
  readonly onRestore: (entry: ReviewEntry) => void;
  readonly onComment: (entry: ReviewEntry, note: string) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const heading = useRef<HTMLHeadingElement>(null);
  const [selected, setSelected] = useState(initialSelection);
  const [section, setSection] = useState("");
  const [filter, setFilter] = useState<Filter>("pending");
  const [batchCount, setBatchCount] = useState<number>();
  const [focusRequest, setFocusRequest] = useState(0);
  const focusHeading = useRef(true);
  const [comment, setComment] = useState<string | null>(null);
  const commentInput = useRef<HTMLInputElement>(null);
  const [deciding, setDeciding] = useState(false);
  const [files, setFiles] = useState<readonly SavedReviewLink[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [switching, setSwitching] = useState(false);
  const [fileError, setFileError] = useState<"filesUnavailable" | "fileOpenFailed">();
  const disabled = busy || deciding || switching;
  const bySection = new Map<string, ReviewEntry[]>();
  for (const entry of entries) {
    const items = bySection.get(entry.section.id);
    if (items) items.push(entry);
    else bySection.set(entry.section.id, [entry]);
  }
  const scope = bySection.get(section) ?? entries;
  const pending = scope.filter(isPending);
  const visible =
    filter === "pending"
      ? pending
      : scope.filter((entry) =>
          filter === "dismissed" ? entry.status === "discarded" : filter === "all" || entry.note,
        );
  const current = visible.find((entry) => entry.key === selected) ?? visible[0];
  const block = useMemo(() => (current ? onCompare(current) : null), [current, onCompare]);
  const position = current ? visible.indexOf(current) : -1;
  const locatedSection = bySection.get(section)?.[0]?.section;
  const canAcceptSection = pending.some(
    (entry) => !entry.blocked && entry.current === entry.before,
  );
  const currentKey = current?.key;
  const changeType = current
    ? t(
        !current.before
          ? "writing.review.addition"
          : !current.after
            ? "writing.review.deletion"
            : "writing.review.replacement",
      )
    : "";
  const followSelection = useEffectEvent((key: string | undefined) => {
    onSelection(key);
    if (current) onLocate(current);
  });

  useEffect(() => {
    if (!folder) return;
    let active = true;
    void tasks.listReviewsInFolder(folder).then(
      (reviews) => {
        if (active)
          setFiles(
            reviews
              .filter((review) => review.path !== path)
              .sort((a, b) => a.path.localeCompare(b.path) || a.title.localeCompare(b.title)),
          );
      },
      () => {
        if (active) setFileError("filesUnavailable");
      },
    );
    return () => {
      active = false;
    };
  }, [folder, path, tasks]);

  useEffect(() => {
    followSelection(currentKey);
    if (focusHeading.current) {
      focusHeading.current = false;
      heading.current?.focus();
    }
  }, [currentKey]);

  // After a completed decision the same proposal can remain visible (for example
  // when the others in its section require comparison).
  useEffect(() => {
    if (focusRequest) heading.current?.focus();
  }, [focusRequest]);

  const isCommenting = comment !== null;
  useEffect(() => {
    if (isCommenting) commentInput.current?.focus();
  }, [isCommenting]);

  function move(entry: ReviewEntry | undefined) {
    setComment(null);
    setSelected(entry?.key);
    setFocusRequest((request) => request + 1);
  }

  function advance() {
    const index = current ? scope.indexOf(current) : -1;
    const next = scope.slice(index + 1).find(isPending) ?? scope.slice(0, index).find(isPending);
    setFilter("pending");
    move(next);
  }

  async function decide(accept: boolean) {
    if (!current || deciding) return;
    setDeciding(true);
    try {
      if (await onDecide(current, accept)) advance();
      else heading.current?.focus();
    } finally {
      setDeciding(false);
    }
  }

  async function acceptRemaining() {
    if (deciding) return;
    setDeciding(true);
    try {
      setBatchCount(await onAcceptSection(pending));
      setFilter("pending");
      move(undefined);
    } finally {
      setDeciding(false);
    }
  }

  async function openFile() {
    const target = files.find((entry) => entry.id === selectedFile);
    if (!target || disabled) return;
    setSwitching(true);
    setFileError(undefined);
    try {
      if (await onOpenFile(target)) return;
    } catch {
      // The selected document or its task may have disappeared since listing it.
    }
    setSwitching(false);
    setFileError("fileOpenFailed");
  }

  return (
    <dialog
      {...props}
      aria-label={t("writing.review.title")}
      className="m-auto max-h-[85vh] w-[min(48rem,calc(100%-2rem))] rounded-lg border border-(--mint-border) bg-(--mint-bg) p-4 text-sm text-(--mint-fg) backdrop:bg-black/30"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) event.stopPropagation();
      }}
      onCancel={(event) => {
        if (switching) event.preventDefault();
        else props.onCancel(event);
      }}
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t("writing.review.title")}</h2>
        <button type="button" className={buttonClass} onClick={close} disabled={switching}>
          {t("settings.close")}
        </button>
      </header>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        {files.length > 0 && folder ? (
          <>
            <label className="grid min-w-0 gap-1">
              {t("writing.review.file")}
              <select
                className={selectClass}
                disabled={disabled}
                value={selectedFile}
                onChange={(event) => setSelectedFile(event.target.value)}
              >
                <option value="">{path ? relativePath(folder, path) : file}</option>
                {files.map((entry, index) => {
                  const duplicate =
                    entry.path === files[index - 1]?.path || entry.path === files[index + 1]?.path;
                  const name = relativePath(folder, entry.path);
                  return (
                    <option key={entry.id} value={entry.id}>
                      {duplicate ? `${name} · ${entry.title}` : name}
                    </option>
                  );
                })}
              </select>
            </label>
            <button
              type="button"
              className={buttonClass}
              disabled={disabled || !selectedFile}
              onClick={() => void openFile()}
            >
              {t("writing.review.openFile")}
            </button>
          </>
        ) : (
          <p className="w-full wrap-anywhere">{file}</p>
        )}
        <label className="grid min-w-0 gap-1">
          {t("writing.review.section")}
          <select
            className={selectClass}
            disabled={deciding || switching}
            value={locatedSection ? section : ""}
            onChange={(event) => {
              setSection(event.target.value);
              setSelected(undefined);
              setComment(null);
            }}
          >
            <option value="">{t("writing.review.allSections")}</option>
            {[...bySection].map(([id, items]) => (
              <option key={id} value={id}>
                {t("writing.review.distribution", {
                  section: items[0]?.section.name ?? "",
                  pending: String(items.filter(isPending).length),
                  total: String(items.length),
                })}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          {t("writing.review.status")}
          <select
            className={selectClass}
            disabled={deciding || switching}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as Filter);
              setSelected(undefined);
              setComment(null);
            }}
          >
            {filters.map((value) => (
              <option key={value} value={value}>
                {t(`writing.review.filter.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {locatedSection && (
          <button
            type="button"
            className={buttonClass}
            disabled={disabled || !canAcceptSection}
            onClick={() => void acceptRemaining()}
          >
            {t("writing.review.acceptSection", { section: locatedSection.name })}
          </button>
        )}
      </div>
      {switching && <p role="status">{t("writing.review.openingFile")}</p>}
      {fileError && <p role="alert">{t(`writing.review.${fileError}`)}</p>}
      {batchCount !== undefined && (
        <p role="status" className="mb-2">
          {t("writing.review.accepted", { count: String(batchCount) })}
        </p>
      )}
      <h3 ref={heading} tabIndex={-1} className="mb-2 font-medium">
        {current
          ? t("writing.review.position", {
              type: block
                ? t("writing.review.blockType", {
                    block: t(`writing.review.${block.kind}`),
                    type: changeType,
                  })
                : changeType,
              index: String(entries.indexOf(current) + 1),
              total: String(entries.length),
            })
          : t("writing.review.empty")}
      </h3>
      {current && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => move(visible[position - 1])}
              disabled={position <= 0 || deciding || switching}
            >
              {t("writing.review.previous")}
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => move(visible[position + 1])}
              disabled={position >= visible.length - 1 || deciding || switching}
            >
              {t("writing.review.next")}
            </button>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={source}
                onChange={(event) => onSource(event.target.checked)}
              />
              {t("writing.edit.source")}
            </label>
          </div>
          <ProposedSelectionEdit
            label={t("writing.edit.position", {
              index: String(entries.indexOf(current) + 1),
              total: String(entries.length),
            })}
            before={current.before}
            after={current.after}
            review={{
              before:
                (block?.prefix ?? "") +
                (current.status === "preview" ? current.current : current.before) +
                (block?.suffix ?? ""),
              after: (block?.prefix ?? "") + current.after + (block?.suffix ?? ""),
            }}
            status={current.status}
            current={
              current.status === "preview" && current.current !== current.before
                ? current.current
                : undefined
            }
            blocked={current.status === "preview" ? current.blocked : undefined}
            source={source}
            busy={disabled}
            onApply={
              current.status === "preview" && !current.blocked ? () => void decide(true) : undefined
            }
            onDiscard={current.status === "preview" ? () => void decide(false) : undefined}
          />
          {current.note && <p className="mt-2 whitespace-pre-wrap wrap-anywhere">{current.note}</p>}
          {current.status === "discarded" && (
            <button
              type="button"
              className={`mt-2 ${buttonClass}`}
              disabled={disabled}
              onClick={() => {
                onRestore(current);
                setFilter(current.note ? "commented" : "pending");
                move(current);
              }}
            >
              {t("writing.review.restore")}
            </button>
          )}
          {current.status === "preview" && comment === null && (
            <button
              type="button"
              className={`mt-2 ${buttonClass}`}
              disabled={disabled}
              onClick={() => setComment(current.note ?? "")}
            >
              {t("writing.review.comment")}
            </button>
          )}
          {comment !== null && (
            <form
              className="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!comment.trim()) return;
                onComment(current, comment.trim());
                advance();
              }}
            >
              <label className="grid min-w-0 flex-1 gap-1">
                {t("writing.review.commentText")}
                <input
                  ref={commentInput}
                  className="min-w-0 rounded border border-(--mint-border) bg-(--mint-bg) px-2 py-1"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
              <button type="submit" className={buttonClass} disabled={!comment.trim()}>
                {t("writing.review.saveComment")}
              </button>
            </form>
          )}
        </>
      )}
    </dialog>
  );
}

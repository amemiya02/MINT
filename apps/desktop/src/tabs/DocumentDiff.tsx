import { useMemo } from "react";
import { diffLines } from "./line-diff.ts";

export function DocumentDiff({
  before,
  after,
}: {
  readonly before: string;
  readonly after: string;
}) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  return (
    <pre className="min-h-0 flex-1 overflow-auto px-5 py-3 font-(family-name:--mint-font-editor) text-sm leading-relaxed">
      {lines.map((line, i) => {
        const key = `${i}`;
        if (line.kind === "removed")
          return (
            <del key={key} className="block bg-(--mint-diff-removed-bg) no-underline">
              {`- ${line.text}`}
            </del>
          );
        if (line.kind === "added")
          return (
            <ins key={key} className="block bg-(--mint-diff-added-bg) no-underline">
              {`+ ${line.text}`}
            </ins>
          );
        return <span key={key} className="block">{`  ${line.text}`}</span>;
      })}
    </pre>
  );
}

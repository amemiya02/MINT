import { useRef, useState } from "react";
import { commands } from "../commands.ts";
import { useT } from "../i18n/index.ts";
import { useTabStore } from "../tabs/context.ts";
import { tabName } from "../tabs/tab-name.ts";
import type { Tab } from "../tabs/tab-store.ts";

const formats = commands.filter((command) => command.menu === "format");

export type ToolbarPosition = "top" | "side" | "hidden";

export function FormattingToolbar({
  tab,
  position,
}: {
  readonly tab: Tab;
  readonly position: Exclude<ToolbarPosition, "hidden">;
}) {
  const store = useTabStore();
  const t = useT();
  const [tabStop, setTabStop] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const vertical = position === "side";

  return (
    <div
      role="toolbar"
      aria-label={t(tab.pane === "primary" ? "toolbar.left" : "toolbar.right", {
        name: tabName(t, tab),
      })}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={`flex shrink-0 items-center gap-1 border-(--mint-border) p-1 ${vertical ? "flex-col border-r" : "border-b"}`}
    >
      {formats.map((command, index) => (
        <button
          key={command.id}
          type="button"
          ref={(button) => {
            buttons.current[index] = button;
          }}
          tabIndex={tabStop === index ? 0 : -1}
          onFocus={() => setTabStop(index)}
          onKeyDown={(event) => {
            const next = vertical ? "ArrowDown" : "ArrowRight";
            const previous = vertical ? "ArrowUp" : "ArrowLeft";
            if (event.key !== next && event.key !== previous) return;
            event.preventDefault();
            const offset = event.key === next ? 1 : -1;
            buttons.current[(index + offset + formats.length) % formats.length]?.focus();
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const editor = store.editor(tab.id);
            editor?.execute(command.editor[0]);
            editor?.focus();
          }}
          className="rounded px-2 py-1 text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
        >
          {t(command.title)}
        </button>
      ))}
    </div>
  );
}

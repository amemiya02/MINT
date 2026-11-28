import { useState } from "react";
import type { ExportFormat } from "../export/ExportDialog.tsx";
import type { FindMode } from "../find/FindBar.tsx";

/** Which dialogs, bars and overlays of a window are showing. */
export function useOverlays() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [paletteVisible, setPaletteVisible] = useState(false);
  /** True while the settings window records a shortcut: no shortcut may run meanwhile. */
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  /** The tab being exported, and to what, while the export dialog shows. */
  const [exporting, setExporting] = useState<{
    readonly tab: number;
    readonly format?: ExportFormat;
  } | null>(null);
  const [find, setFind] = useState<{ mode: FindMode; request: number } | null>(null);
  /** While global search shows (in place of the file tree), how many times it was invoked. */
  const [folderSearch, setFolderSearch] = useState<number | null>(null);
  return {
    settingsOpen,
    setSettingsOpen,
    quickOpenVisible,
    setQuickOpenVisible,
    paletteVisible,
    setPaletteVisible,
    recordingShortcut,
    setRecordingShortcut,
    exporting,
    setExporting,
    find,
    setFind,
    folderSearch,
    setFolderSearch,
  };
}

/**
 * How the window exporting a PDF hands its document to the print window it
 * opens: the print window announces its label on `ready` once it listens,
 * then receives the document on `document`.
 */
export const printEvents = {
  ready: "mint://print-ready",
  document: "mint://print-document",
} as const;

/** What the print window receives: the standalone HTML and the print job's name. */
export interface PrintJob {
  readonly target?: string;
  readonly paper: "A4" | "A5" | "Letter";
  readonly html: string;
  readonly title: string;
}

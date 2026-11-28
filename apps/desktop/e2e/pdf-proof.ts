import { expect } from "@playwright/test";
import { extractImages, extractTextItems, getDocumentProxy } from "unpdf";

export const fieldNotes = [
  "# Field notes",
  "",
  "![chart](chart.png)",
  "",
  "| Site | Result |",
  "| --- | --- |",
  ...Array.from({ length: 32 }, (_, n) => `| Station ${n + 1} | Verified |`),
  "",
  Array.from({ length: 450 }, (_, n) => `Observation-${n + 1}`).join(" "),
].join("\n");

export async function verifyFieldNotes(pdf: Uint8Array, expected: string[]) {
  const file = await getDocumentProxy(new Uint8Array(pdf));
  try {
    const { items } = await extractTextItems(file);
    expect(items).toHaveLength(expected.length);
    // Compare every station and word with its preview page. PDF coordinates
    // are points, measured from the lower-left corner.
    const compact = (text: string) => text.replace(/\s/g, "");
    for (const [i, words] of items.entries()) {
      expect(compact(words.map((item) => item.str).join(""))).toBe(compact(expected[i] ?? ""));
      const sheet = await file.getPage(i + 1);
      const { width, height } = sheet.getViewport({ scale: 1 });
      expect(Math.abs(width - (148 * 72) / 25.4)).toBeLessThan(1);
      expect(Math.abs(height - (210 * 72) / 25.4)).toBeLessThan(1);
      const inset = (22 * 72) / 25.4 - 2; // fractional-pixel rounding
      for (const word of words.filter((word) => word.str.trim())) {
        expect(word.x).toBeGreaterThanOrEqual(inset);
        expect(word.x + word.width).toBeLessThanOrEqual(width - inset);
        expect(word.y).toBeGreaterThanOrEqual(inset);
        expect(word.y).toBeLessThanOrEqual(height - inset);
      }
    }
    const [chart] = await extractImages(file, 1);
    expect(chart?.width).toBe(1);
    expect(chart?.bounds.width).toBeGreaterThan(0);
  } finally {
    await file.cleanup();
  }
}

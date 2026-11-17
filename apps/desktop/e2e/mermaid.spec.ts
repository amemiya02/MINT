import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

const doc = [
  "# Diagrams",
  "",
  "```mermaid",
  "flowchart LR",
  "  Draft --> Review --> Publish",
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  Alice->>Bob: Hello Bob",
  "  Bob-->>Alice: Hi Alice",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  A -->",
  "```",
  "",
].join("\n");

test("renders Mermaid diagrams, reports syntax errors and shows the source on click", async ({
  page,
}) => {
  const path = "/notes/diagrams.md";
  const mermaidRequests: string[] = [];
  page.on("request", (request) => {
    if (/node_modules\/.*mermaid|\/deps\/mermaid/.test(request.url()))
      mermaidRequests.push(request.url());
  });
  await launch(page, { files: { [path]: doc }, openDialogResults: [path], locale: "en-US" });
  await page.waitForLoadState("networkidle");
  // Loaded on demand: starting MINT does not load Mermaid.
  expect(mermaidRequests).toEqual([]);

  await page.keyboard.press("ControlOrMeta+O");
  const diagrams = page.locator(".cm-mint-mermaid");
  await expect(diagrams).toHaveCount(3);

  const flowchart = diagrams.nth(0);
  // The first diagram waits for Mermaid to load (a big module, slow on a loaded machine).
  await expect(flowchart.locator("svg")).toBeVisible({ timeout: 30_000 });
  for (const label of ["Draft", "Review", "Publish"]) {
    await expect(flowchart.locator("svg").getByText(label, { exact: true })).toBeVisible();
  }
  const sequence = diagrams.nth(1);
  await expect(sequence.locator("svg").getByText("Hello Bob")).toBeVisible();
  await expect(sequence.locator("svg").getByText("Hi Alice")).toBeVisible();

  await expect(diagrams.nth(2).getByRole("alert")).toContainText("Mermaid:");
  await expect(diagrams.nth(2).locator("svg")).toHaveCount(0);
  expect(mermaidRequests.length).toBeGreaterThan(0);

  // Clicking a diagram puts the cursor in its block: the source shows and can be edited.
  await flowchart.click();
  await expect(diagrams).toHaveCount(2);
  const sourceLine = page.locator(".cm-line", { hasText: "Draft --> Review --> Publish" });
  await expect(sourceLine).toBeVisible();
  await sourceLine.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" --> Done");

  // Leaving the block renders it again, with the edit.
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(diagrams).toHaveCount(3);
  await expect(diagrams.nth(0).locator("svg").getByText("Done", { exact: true })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(
    doc.replace("Draft --> Review --> Publish", "Draft --> Review --> Publish --> Done"),
  );
});

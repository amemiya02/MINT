import { expect, type Page, test } from "@playwright/test";
import { externalWrite, launch, readFile, runMenuItem } from "./memory-platform.ts";

const root = "/research";
const source =
  "\uFEFF# Draft\r\n\r\nSee [evidence][ref].  \r\n\r\n[ref]: data/Report.md#Results\r\n";
const report = "# Report\n\n## Results\n\nThree nests.\n";
const files = {
  [`${root}/draft.md`]: source,
  [`${root}/data/Report.md`]: report,
  [`${root}/other.md`]: "`[literal](draft.md)` [missing](absent.md) [outside](../private.md)",
  "/private.md": "# Private",
};
const name = "Relationship graph";

async function installGraph(page: Page, grant = true) {
  await launch(page, { locale: "en-US", files, openFolderDialogResults: [root] });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const plugin = settings.getByRole("group", { name, exact: true });
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await settings.getByRole("button", { name: grant ? "Allow access" : "Deny access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const entry = page
    .getByRole("navigation", { name: "Document tools" })
    .getByRole("button", { name });
  await entry.click();
  return { graph: page.getByRole("complementary", { name }), entry, settings, plugin };
}

test("the graph opens both ends of an actual reference at the same occurrence as Backlinks", async ({
  page,
}) => {
  const { graph } = await installGraph(page);
  await expect(graph.getByRole("list", { name: "References" }).getByRole("listitem")).toHaveCount(
    1,
  );
  const edge = graph.getByRole("list", { name: "References" }).getByRole("listitem");
  await edge.getByRole("button", { name: /draft\.md/ }).click();
  await expect(page).toHaveTitle("draft.md — MINT");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("[evidence][ref]");
  await edge.getByRole("button", { name: /data\/Report\.md/ }).click();
  await expect(page).toHaveTitle("Report.md — MINT");
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent,
      ),
    )
    .toContain("Results");
  await page.getByRole("button", { name: "Backlinks", exact: true }).click();
  const backlinks = page.getByRole("complementary", { name: "Backlinks" }).getByRole("button");
  await expect(backlinks).toHaveCount(1);
  await backlinks.filter({ hasText: "draft.md" }).click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("[evidence][ref]");
  expect(await readFile(page, `${root}/draft.md`)).toBe(source);
  expect(await readFile(page, `${root}/data/Report.md`)).toBe(report);
});

test("linked documents form a browsable network as folder references and wikilink settings change", async ({
  page,
}) => {
  const { graph, settings } = await installGraph(page);
  const nodes = graph.getByRole("navigation", { name: "Linked documents" }).getByRole("button");
  await expect(nodes).toHaveCount(2);
  await externalWrite(page, `${root}/other.md`, "[draft](draft.md) and [[Report#Results]]");
  const edges = graph.getByRole("list", { name: "References" }).getByRole("listitem");
  await expect(edges).toHaveCount(2);
  await expect(nodes).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+,");
  await settings.getByRole("checkbox", { name: "Recognize wikilinks in /research" }).check();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(edges).toHaveCount(3);
  await expect(nodes).toHaveCount(3);
  const node = nodes.filter({ hasText: "other.md" });
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("other.md — MINT");
  await edges
    .filter({ hasText: "other.md" })
    .getByRole("button", { name: /data\/Report\.md/ })
    .click();
  await expect(page).toHaveTitle("Report.md — MINT");
});

test("the folder read grant controls graph access and disabling it removes the sidebar", async ({
  page,
}) => {
  const { graph, settings, plugin, entry } = await installGraph(page, false);
  const denied = graph.getByRole("alert");
  await expect(denied).toHaveText("Permission to read the current folder was denied.");
  await expect(graph.getByRole("button")).toHaveCount(0);
  async function setting(action: string) {
    await page.keyboard.press("ControlOrMeta+,");
    await plugin.getByRole("button", { name: action, exact: true }).click();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
  }
  await setting("Allow access");
  await expect(graph.getByRole("listitem")).toHaveCount(1);
  await setting("Revoke access");
  await expect(denied).toBeVisible();
  await expect(graph.getByRole("button")).toHaveCount(0);
  await setting("Disable");
  await expect(graph).toHaveCount(0);
  await expect(entry).toHaveCount(0);
  for (const [path, bytes] of Object.entries(files)) expect(await readFile(page, path)).toBe(bytes);
});

test("an imported graph package follows the current folder", async ({ page }) => {
  await launch(page, {
    locale: "en-US",
    files: { ...files, "/separate/notes.md": "[cross-folder](../research/draft.md)" },
    openFolderDialogResults: [root, "/separate"],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const label = "Citation map";
  await settings.getByLabel("Install a MINT plugin file").setInputFiles({
    name: "citations.mint.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        apiVersion: 1,
        id: "example.citations",
        name: label,
        permissions: ["folder.read"],
        sidebar: "graph",
      }),
    ),
  });
  await settings.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const entry = page.getByRole("button", { name: label, exact: true });
  const graph = page.getByRole("complementary", { name: label });
  await entry.click();
  await expect(graph).toContainText("Open a folder");
  await runMenuItem(page, "file.openFolder");
  await page.getByRole("treeitem", { name: "draft.md" }).waitFor();
  await entry.click();
  await expect(graph.getByRole("listitem")).toHaveCount(1);
  await runMenuItem(page, "file.openFolder");
  await page.getByRole("treeitem", { name: "notes.md" }).waitFor();
  await entry.click();
  await expect(graph).toContainText("No document references in this folder.");
  await expect(graph.getByRole("button")).toHaveCount(0);
});

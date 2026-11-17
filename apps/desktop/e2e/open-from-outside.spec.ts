import { expect, test } from "@playwright/test";
import { launch, openFromOutside } from "./memory-platform.ts";

test("a document double-clicked before MINT started opens in a tab", async ({ page }) => {
  await launch(page, {
    files: { "/notes/todo.md": "# Todo\n\n- milk\n" },
    openedPaths: [{ path: "/notes/todo.md", kind: "file" }],
    locale: "en-US",
  });

  await expect(page.getByRole("textbox")).toContainText("milk");
  await expect(page).toHaveTitle("todo.md — MINT");
});

test("documents and folders handed over while MINT runs open in the window", async ({ page }) => {
  await launch(page, {
    files: {
      "/notes/a.md": "# Alpha\n",
      "/notes/b.md": "# Beta\n",
      "/project/readme.md": "# Readme\n",
    },
    locale: "en-US",
  });

  await openFromOutside(page, [
    { path: "/notes/a.md", kind: "file" },
    { path: "/notes/b.md", kind: "file" },
    { path: "/project", kind: "directory" },
  ]);

  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "b.md" })).toBeVisible();
  await expect(page.getByRole("tree", { name: "project" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "readme.md", exact: true })).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("a writer previews, edits and disables digital timing diagrams alongside Mermaid", async ({
  page,
}) => {
  const path = "/notes/bus.md";
  const draft =
    "\uFEFF# Bus handshake  \r\n\r\n```timing\r\nCLK: 0101\r\nACK: 0011\r\n```\r\n\r\n```mermaid\r\nflowchart LR\r\n  Bus --> Device\r\n```\r\n";
  await launch(page, { files: { [path]: draft }, openDialogResults: [path], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByText("CLK: 0101", { exact: true })).toBeVisible();
  const clock = page.getByRole("img", { name: "CLK: 0101", exact: true });
  await expect(clock).toHaveCount(0);
  const device = page.locator(".cm-mint-mermaid svg").getByText("Device", { exact: true });
  await expect(device).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const plugin = settings.getByRole("group", { name: "Digital timing diagrams" });
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Install" }).click();
  await settings.getByRole("button", { name: "Deny access" }).click();
  const example = plugin.getByText("Example Markdown", { exact: true });
  await expect(example).toBeVisible();
  await example.click();
  await expect(plugin.locator("pre")).toContainText("CLK: 0101");
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(clock).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(clock).toBeVisible();

  const ack = page.getByRole("img", { name: "ACK: 0011", exact: true });
  await expect(ack.locator("path")).toBeVisible();
  const originalTrace = await ack.locator("path").getAttribute("d");
  await ack.click();
  const ackLine = page.locator(".cm-line", { hasText: "ACK: " });
  await ackLine.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("0");
  await page.keyboard.press("ControlOrMeta+Home");
  const edited = page.getByRole("img", { name: "ACK: 0010" });
  await expect(edited).toBeVisible();
  expect(await edited.locator("path").getAttribute("d")).not.toBe(originalTrace);

  await edited.click();
  await ackLine.click();
  await page.keyboard.press("End");
  await page.keyboard.type("?");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(page.getByRole("alert")).toContainText("Invalid timing diagram");
  await expect(page.locator(".cm-content")).toContainText("ACK: 0010?");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(page, path)).toBe(draft.replace("0011", "0010?"));
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Disable" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(ackLine).toHaveText("ACK: 0010?");
  await ackLine.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(edited).toHaveCount(0);
  await expect(device).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(page, path)).toBe(draft.replace("0011", "0010"));
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Enable", exact: true }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(edited).toBeVisible();
  await page.keyboard.press("ControlOrMeta+/");
  await expect(edited).toHaveCount(0);
  await expect(ackLine).toHaveText("ACK: 0010");
  await page.keyboard.press("ControlOrMeta+/");
  await expect(edited).toBeVisible();
});

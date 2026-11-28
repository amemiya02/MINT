import { expect, type Locator, test } from "@playwright/test";
import { selectedPageText, writingMaterialPdf } from "../test-fixtures/writing-materials.ts";
import { launch } from "./memory-platform.ts";

const address = "https://ranges.example.test/v1";
const endpoint = `${address}/chat/completions`;

async function dropPdf(context: Locator) {
  await context.evaluate((element, pdf) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([pdf], "field-notes.pdf", { type: "application/pdf" }));
    transfer.items.add(new File(["Visitor bulletin."], "audience.txt"));
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  }, writingMaterialPdf());
}

test("draft from two materials and send only the selected PDF page as text", async ({ page }) => {
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: { choices: [{ message: { content: "The deck opens Tuesday." }, finish_reason: "stop" }] },
    }),
  );
  await launch(page, { locale: "en-US" });
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("API address").fill(address);
  await composer.getByLabel("Model name").fill("text-fixture");
  await composer.getByLabel("Drafting instruction").fill("Write a bulletin.");
  const context = composer.getByRole("group", { name: "Task context to send" });
  await dropPdf(context);
  const pdf = context.getByRole("group", { name: "field-notes.pdf" });
  await expect(composer.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  await pdf.getByLabel("PDF page").fill("2");
  await pdf.getByRole("button", { name: "Use selected material" }).click();
  await context.getByText("field-notes.pdf · Page 2 of 2 · Extracted text", { exact: true }).click();
  await expect(context.getByText(selectedPageText, { exact: true })).toBeVisible();

  const [request] = await Promise.all([
    page.waitForRequest(endpoint),
    composer.getByRole("button", { name: "Generate draft" }).click(),
  ]);
  const body = request.postDataJSON();
  expect(body.model).toBe("text-fixture");
  expect(JSON.parse(body.messages.at(-1).content).taskContext.materials).toEqual(
    expect.arrayContaining([
      {
        name: "field-notes.pdf",
        text: selectedPageText,
        range: { kind: "pdf", page: 2, pages: 2 },
        format: "extractedText",
      },
      { name: "audience.txt", text: "Visitor bulletin." },
    ]),
  );
  expect(JSON.parse(body.messages.at(-1).content).taskContext.materials).toHaveLength(2);
  await expect(page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true })).toHaveText(
    "The deck opens Tuesday.",
  );
});

test("paste an image into Ask AI and transmit only the crop to the chosen visual model", async ({
  page,
}) => {
  const manuscript = "/notes/observation.md";
  const selection = "The chart needs a closer reading.";
  const visionAddress = "https://vision.example.test/v1";
  const visionEndpoint = `${visionAddress}/chat/completions`;
  const received: unknown[] = [];
  const textRequests: unknown[] = [];
  await page.route(endpoint, (route) => {
    textRequests.push(route.request().postDataJSON());
    return route.fulfill({
      json: { choices: [{ message: { content: "Caption reviewed." }, finish_reason: "stop" }] },
    });
  });
  await page.route(visionEndpoint, (route) => {
    const content = route.request().postDataJSON().messages.at(-1).content;
    received.push(content);
    const text = received.length === 1 ? "green,yellow" : "The marked region is blue.";
    return route.fulfill({
      json: { choices: [{ message: { content: text }, finish_reason: "stop" }] },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [manuscript]: selection },
    openedPaths: [{ path: manuscript, kind: "file" }],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  for (const [name, service] of [
    ["Text fixture", address],
    ["Vision fixture", visionAddress],
  ] as const) {
    await settings.getByLabel("Connection name").fill(name);
    await settings.getByLabel("API address").fill(service);
    await settings.getByLabel("Model name").fill("fixture");
    await settings.getByRole("button", { name: "Use for this launch" }).click();
    await expect(settings.getByRole("region", { name, exact: true })).toBeVisible();
  }
  await settings.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true }).click();
  await page.keyboard.press("End");
  for (const _ of selection) await page.keyboard.press("Shift+ArrowLeft");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  let ask = page.getByRole("region", { name: "Ask AI" });
  await ask.getByLabel("Action").selectOption({ label: "Comment only" });
  await ask.getByLabel("Instruction", { exact: true }).fill("Read the marked region.");
  let context = ask.getByRole("group", { name: "Task context to send" });
  await ask.getByLabel("Instruction", { exact: true }).evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 4;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#ff0000";
    drawing.fillRect(0, 0, 8, 4);
    drawing.fillStyle = "#0000ff";
    drawing.fillRect(5, 1, 2, 2);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((result) => resolve(result!)));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([blob], "chart.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true }));
  });

  let image = context.getByRole("group", { name: "chart.png" });
  await image.getByLabel("Left (px)").fill("5");
  await image.getByLabel("Top (px)").fill("1");
  await image.getByLabel("Width (px)").fill("2");
  await image.getByLabel("Height (px)").fill("2");
  await expect(image.getByRole("option", { name: "Image pixels" })).toHaveJSProperty("disabled", true);
  await image.getByLabel("Caption", { exact: true }).fill("Detail from the lower chart.");
  await image.getByRole("button", { name: "Use selected material" }).click();
  await expect(context.getByText("chart.png · x 5, y 1 · 2 × 2 px · Caption")).toBeVisible();
  await ask.getByRole("button", { name: /^Comment only · Current selection · Text fixture/ }).click();
  await expect(ask.getByText("Caption reviewed.", { exact: true })).toBeVisible();
  const textBody = textRequests[0] as { messages: { content: string }[] };
  expect(JSON.parse(textBody.messages.at(-1)?.content ?? "").taskContext.materials).toEqual([
    {
      name: "chart.png",
      text: "Detail from the lower chart.",
      range: { kind: "image", x: 5, y: 1, width: 2, height: 2 },
      format: "caption",
    },
  ]);
  await ask.getByRole("button", { name: "Continue in sidebar" }).click();
  ask = page.getByRole("complementary", { name: "Writing Assistant" });
  context = ask.getByRole("group", { name: "Task context to send" });
  await ask.getByLabel("Recipient").selectOption({ label: `Vision fixture · ${visionEndpoint}` });
  await context.getByRole("button", { name: "Check image support" }).click();
  await expect(context.getByText("Image support verified")).toBeVisible();
  expect(received).toHaveLength(1);
  expect(JSON.stringify(received[0])).not.toContain("chart.png");
  await context.getByRole("button", { name: "Edit chart.png" }).click();
  image = context.getByRole("group", { name: "chart.png" });
  await image.getByLabel("Send as").selectOption({ label: "Image pixels" });
  await image.getByRole("button", { name: "Use selected material" }).click();
  await expect(context.getByText("chart.png · x 5, y 1 · 2 × 2 px · Image pixels")).toBeVisible();
  await ask.getByLabel("Instruction", { exact: true }).fill("Check the crop pixels.");
  await ask.getByLabel("Recipient").selectOption({ label: `Text fixture · ${endpoint}` });
  await expect(ask.getByRole("button", { name: /^Comment only · Current selection · Text fixture/ })).toBeDisabled();
  await ask.getByLabel("Recipient").selectOption({ label: `Vision fixture · ${visionEndpoint}` });
  await ask.getByRole("button", { name: /^Comment only · Current selection · Vision fixture/ }).click();
  await expect(ask.getByText("The marked region is blue.", { exact: true })).toBeVisible();

  const parts = received[1] as unknown as [
    { type: string; text: string },
    { type: string; image_url: { url: string } },
  ];
  expect(parts).toHaveLength(2);
  expect(JSON.parse(parts[0].text).taskContext.materials).toEqual([
    { name: "chart.png", range: { kind: "image", x: 5, y: 1, width: 2, height: 2 }, format: "image" },
  ]);
  expect(parts[1].type).toBe("image_url");
  expect(parts[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  const crop = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const drawing = canvas.getContext("2d")!;
    drawing.drawImage(image, 0, 0);
    return [image.width, image.height, ...drawing.getImageData(0, 0, 2, 2).data];
  }, parts[1].image_url.url);
  expect(crop).toEqual([2, 2, ...Array.from({ length: 4 }, () => [0, 0, 255, 255]).flat()]);
  expect(textRequests).toHaveLength(1);
  expect(received).toHaveLength(2);
});

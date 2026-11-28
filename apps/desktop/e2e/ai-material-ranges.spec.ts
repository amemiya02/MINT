import { expect, type Locator, test } from "@playwright/test";
import {
  otherPageText,
  selectedPageText,
  writingMaterialChart,
  writingMaterialPdf,
} from "../test-fixtures/writing-materials.ts";
import { launch, pickFile, readFile, runMenuItem } from "./memory-platform.ts";

const address = "https://ranges.example.test/v1";
const endpoint = `${address}/chat/completions`;

async function dropPdf(context: Locator, withAudience = false) {
  await context.evaluate(
    (element, { pdf, withAudience }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([pdf], "field-notes.pdf", { type: "application/pdf" }));
      if (withAudience) transfer.items.add(new File(["Visitor bulletin."], "audience.txt"));
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    },
    { pdf: writingMaterialPdf(), withAudience },
  );
}

test("draft from two materials and cite the selected PDF page after the source changes", async ({
  page,
}) => {
  const supported = "The deck opens Tuesday.";
  const unsupported = "There is a private access code.";
  const generated = `${supported} ${unsupported}`;
  const reply = `${generated}\n\n<source-passages>\n${JSON.stringify([
    { claim: supported, material: 1, quote: selectedPageText },
    { claim: unsupported, material: 1, quote: otherPageText },
  ])}\n</source-passages>`;
  const draftPath = "/notes/bulletin.md";
  let sends = 0;
  await page.route(endpoint, (route) => {
    sends++;
    return route.fulfill({
      json: {
        choices: [{ message: { content: reply }, finish_reason: "stop" }],
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    directories: ["/notes"],
    saveDialogResults: [draftPath],
  });
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("API address").fill(address);
  await composer.getByLabel("Model name").fill("text-fixture");
  await composer.getByLabel("Drafting instruction").fill("Write a bulletin.");
  const context = composer.getByRole("group", { name: "Task context to send" });
  await dropPdf(context, true);
  const pdf = context.getByRole("group", { name: "field-notes.pdf" });
  await expect(composer.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  await pdf.getByLabel("PDF page").fill("2");
  await pdf.getByRole("button", { name: "Use selected material" }).click();
  await context
    .getByText("field-notes.pdf · Page 2 of 2 · Extracted text", { exact: true })
    .click();
  await expect(context.getByText(selectedPageText, { exact: true })).toBeVisible();

  const [request] = await Promise.all([
    page.waitForRequest(endpoint),
    composer.getByRole("button", { name: "Generate draft" }).click(),
  ]);
  const body = request.postDataJSON();
  expect(body.model).toBe("text-fixture");
  expect(body.messages).toContainEqual({
    role: "system",
    content: expect.stringContaining("<source-passages>"),
  });
  expect(JSON.parse(body.messages.at(-1).content).taskContext.materials).toEqual([
    {
      name: "field-notes.pdf",
      text: selectedPageText,
      range: { kind: "pdf", page: 2, pages: 2 },
      format: "extractedText",
    },
    { name: "audience.txt", text: "Visitor bulletin." },
  ]);
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await expect(page.getByRole("tab", { name: /^Untitled/ })).toBeVisible();
  await expect(editor).toHaveText(generated);
  const review = page.getByRole("region", { name: "Source passages" });
  await expect(review.getByRole("listitem").filter({ hasText: unsupported })).toContainText(
    "Needs verification",
  );
  await review.getByRole("button", { name: supported, exact: true }).click();
  const passage = review.getByRole("region", { name: "Excerpt used for this draft" });
  await expect(passage.getByText(selectedPageText, { exact: true })).toBeVisible();
  await expect(passage).toContainText("field-notes.pdf · Page 2 of 2 · Extracted text");
  await runMenuItem(page, "file.save");
  await expect.poll(() => readFile(page, draftPath)).toBe(generated);

  const revised = "Revised page: the observation deck will stay closed.";
  const compare = async (pageTwo: string) => {
    await pickFile(page, passage.getByRole("button", { name: "Choose revised source" }), {
      name: "field-notes.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(writingMaterialPdf(pageTwo)),
    });
  };
  const comparison = passage.getByRole("region", { name: "Source comparison" });
  await compare(revised);
  await expect(comparison).toContainText(revised);
  await compare("");
  await expect(comparison).toContainText(
    "The original excerpt no longer has text at this location.",
  );
  await expect(passage.getByText(selectedPageText, { exact: true })).toBeVisible();
  expect(sends).toBe(1);
  expect(await readFile(page, draftPath)).toBe(generated);

  await passage.getByRole("button", { name: "Cite the original excerpt in Markdown" }).click();
  await runMenuItem(page, "file.save");
  await expect
    .poll(() => readFile(page, draftPath))
    .toBe(
      `${supported}[^mint-source-1] ${unsupported}\n\n[^mint-source-1]: field-notes.pdf · Page 2 of 2 · Extracted text, line 1 of sent material. “${selectedPageText}”\n`,
    );
});

test("changing the selected PDF page requires a new summary before sending", async ({ page }) => {
  const received: unknown[] = [];
  await page.route(endpoint, (route) => {
    const { messages } = route.request().postDataJSON();
    received.push(JSON.parse(messages.at(-1).content).taskContext.materials);
    return route.fulfill({
      json: { choices: [{ message: { content: "The deck opens Tuesday." } }] },
    });
  });
  await launch(page, { locale: "en-US" });
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const draft = page.getByRole("form", { name: "Draft with AI" });
  await draft.getByLabel("API address").fill(address);
  await draft.getByLabel("Model name").fill("text-fixture");
  await draft.getByLabel("Drafting instruction").fill("Write a bulletin.");
  await dropPdf(draft.getByRole("group", { name: "Task context to send" }));

  const pdf = draft.getByRole("group", { name: "field-notes.pdf", exact: true });
  const accept = pdf.getByRole("button", { name: "Use selected material" });
  await accept.click();
  await draft.getByLabel("Material handling").selectOption("summary");
  const summary = draft.getByLabel("Summary to send");
  const send = draft.getByRole("button", { name: "Generate draft" });
  await summary.fill(otherPageText);
  await expect(send).toBeEnabled();

  await draft.getByRole("button", { name: "Edit field-notes.pdf" }).click();
  await pdf.getByLabel("PDF page").fill("2");
  await accept.click();
  await expect(summary).toHaveValue("");
  await expect(send).toBeDisabled();
  expect(received).toHaveLength(0);

  const newSummary = "The observation deck opens Tuesday.";
  await summary.fill(newSummary);
  await send.click();
  await expect
    .poll(() => received)
    .toEqual([
      [
        {
          name: "field-notes.pdf · summary of lines 1–1",
          text: newSummary,
          range: { kind: "pdf", page: 2, pages: 2 },
          format: "summary",
        },
      ],
    ]);
});

test("paste an image into Ask AI and transmit only the crop to the chosen visual model", async ({
  page,
}) => {
  const manuscript = "/notes/observation.md";
  const selection = "The chart needs a closer reading.";
  const visionAddress = "https://vision.example.test/v1";
  const visionEndpoint = `${visionAddress}/chat/completions`;
  type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
  const received: Part[][] = [];
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
  await ask.getByLabel("Instruction", { exact: true }).evaluate((element, png) => {
    const clipboard = new DataTransfer();
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
    clipboard.items.add(new File([bytes], "chart.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true }));
  }, writingMaterialChart);

  let image = context.getByRole("group", { name: "chart.png" });
  await image.getByLabel("Left (px)").fill("5");
  await image.getByLabel("Top (px)").fill("1");
  await image.getByLabel("Width (px)").fill("2");
  await image.getByLabel("Height (px)").fill("2");
  await expect(image.getByRole("option", { name: "Image pixels" })).toHaveJSProperty(
    "disabled",
    true,
  );
  await image.getByLabel("Caption", { exact: true }).fill("Detail from the lower chart.");
  await image.getByRole("button", { name: "Use selected material" }).click();
  await expect(context.getByText("chart.png · x 5, y 1 · 2 × 2 px · Caption")).toBeVisible();
  await ask
    .getByRole("button", { name: /^Comment only · Current selection · Text fixture/ })
    .click();
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
  await dropPdf(context);
  const pdf = context.getByRole("group", { name: "field-notes.pdf" });
  await pdf.getByLabel("PDF page").fill("2");
  await pdf.getByLabel("Send as").selectOption({ label: "Image pixels" });
  await pdf.getByRole("button", { name: "Use selected material" }).click();
  await expect(context.getByText("field-notes.pdf · Page 2 of 2 · Image pixels")).toBeVisible();
  await ask.getByLabel("Instruction", { exact: true }).fill("Check the crop pixels.");
  await ask.getByLabel("Recipient").selectOption({ label: `Text fixture · ${endpoint}` });
  await expect(
    ask.getByRole("button", { name: /^Comment only · Current selection · Text fixture/ }),
  ).toBeDisabled();
  await ask.getByLabel("Recipient").selectOption({ label: `Vision fixture · ${visionEndpoint}` });
  await ask
    .getByRole("button", { name: /^Comment only · Current selection · Vision fixture/ })
    .click();
  await expect(ask.getByText("The marked region is blue.", { exact: true })).toBeVisible();

  expect(received[1]).toHaveLength(3);
  const [prompt, cropPart, pagePart] = received[1] ?? [];
  if (prompt?.type !== "text" || cropPart?.type !== "image_url" || pagePart?.type !== "image_url") {
    throw new Error("Expected a prompt and separate PNGs for the crop and PDF page");
  }
  expect(JSON.parse(prompt.text).taskContext.materials).toEqual([
    {
      name: "chart.png",
      range: { kind: "image", x: 5, y: 1, width: 2, height: 2 },
      format: "image",
    },
    { name: "field-notes.pdf", range: { kind: "pdf", page: 2, pages: 2 }, format: "image" },
  ]);

  async function readPng(url: string, x: number, y: number, width: number, height: number) {
    expect(url).toMatch(/^data:image\/png;base64,/);
    return page.evaluate(
      async ({ url, x, y, width, height }) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const drawing = canvas.getContext("2d");
        if (!drawing) throw new Error("Expected a 2D context");
        drawing.drawImage(image, 0, 0);
        return [image.width, image.height, ...drawing.getImageData(x, y, width, height).data];
      },
      { url, x, y, width, height },
    );
  }
  const crop = await readPng(cropPart.image_url.url, 0, 0, 2, 2);
  expect(crop).toEqual([2, 2, ...Array.from({ length: 4 }, () => [0, 0, 255, 255]).flat()]);
  const pdfPage = await readPng(pagePart.image_url.url, 4, 155, 1, 1);
  expect(pdfPage).toEqual([640, 160, 0, 255, 0, 255]);
  expect(textRequests).toHaveLength(1);
  expect(received).toHaveLength(2);
});

test("draft source review opens the exact image crop sent for a claim", async ({ page }) => {
  const claim = "The marked region is blue.";
  let crop: string | undefined;
  await page.route(endpoint, (route) => {
    const content = route.request().postDataJSON().messages.at(-1).content;
    const evidence = content.find((part: { type: string }) => part.type === "image_url");
    const isDraft = content[0].text.includes("Write using the chart");
    if (isDraft) crop = evidence.image_url.url;
    const reply = isDraft
      ? `${claim}\n\n<source-passages>[{"claim":"${claim}","material":1,"image":true}]</source-passages>`
      : "green,yellow";
    return route.fulfill({ json: { choices: [{ message: { content: reply } }] } });
  });
  await launch(page, { locale: "en-US" });
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const draft = page.getByRole("form", { name: "Draft with AI" });
  await draft.getByLabel("API address").fill(address);
  await draft.getByLabel("Model name").fill("vision-fixture");
  await draft.getByLabel("Drafting instruction").fill("Write using the chart.");
  const context = draft.getByRole("group", { name: "Task context to send" });
  await context.evaluate((element, png) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], "chart.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  }, writingMaterialChart);
  const image = context.getByRole("group", { name: "chart.png" });
  await context.getByRole("button", { name: "Check image support" }).click();
  await expect(context.getByText("Image support verified")).toBeVisible();
  await image.getByLabel("Left (px)").fill("5");
  await image.getByLabel("Top (px)").fill("1");
  await image.getByLabel("Width (px)").fill("2");
  await image.getByLabel("Height (px)").fill("2");
  await image.getByLabel("Send as").selectOption({ label: "Image pixels" });
  await image.getByRole("button", { name: "Use selected material" }).click();
  await draft.getByRole("button", { name: "Generate draft" }).click();

  const review = page.getByRole("region", { name: "Source passages" });
  await review.getByRole("button", { name: claim, exact: true }).click();
  const sent = review.getByRole("img", { name: /chart.png · x 5, y 1 · 2 × 2 px/ });
  expect(crop).toMatch(/^data:image\/png;base64,/);
  await expect(sent).toHaveAttribute("src", crop ?? "");
});

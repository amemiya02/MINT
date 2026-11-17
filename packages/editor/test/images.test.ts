// Images in live preview, and pasting or dropping image files, through the
// editor core's public interface. Resolving paths and saving files are the
// host's job: these tests play the host.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEditor,
  type EditorOptions,
  type HostAdapter,
  type ImageFile,
  type MintEditor,
} from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  /** The text as displayed: replaced source is absent. */
  const shown = () =>
    [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
  const images = () => [...parent.querySelectorAll<HTMLImageElement>(".cm-mint-image img")];
  const placeholders = () => [...parent.querySelectorAll<HTMLElement>(".cm-mint-image-missing")];
  const content = () => parent.querySelector<HTMLElement>(".cm-content") as HTMLElement;
  return { editor, parent, shown, images, placeholders, content };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

const end = (editor: MintEditor) => editor.setSelection({ anchor: editor.getText().length });

describe("images in live preview", () => {
  it("shows a web image in place of its source while the cursor is elsewhere", () => {
    const { editor, shown, images } = open("![A cat](https://example.com/cat.png)\n\nend");
    end(editor);
    expect(shown()).toBe("\nend");
    expect(images().map((img) => [img.getAttribute("src"), img.alt])).toEqual([
      ["https://example.com/cat.png", "A cat"],
    ]);
  });

  it("asks the host to resolve local paths, relative or absolute, as decoded file paths", () => {
    const resolveImageUrl = vi.fn((src: string) => `asset://${src}`);
    const { editor, images } = open("![a](img/a.png)\n\n![b](/abs/b%20c.png)\n\nend", {
      host: { resolveImageUrl },
    });
    end(editor);
    expect(images().map((img) => img.getAttribute("src"))).toEqual([
      "asset://img/a.png",
      "asset:///abs/b c.png",
    ]);
  });

  it("shows a placeholder when the host cannot resolve the path", () => {
    const { editor, images, placeholders } = open("![gone](missing.png)\n\nend", {
      host: { resolveImageUrl: () => null },
    });
    end(editor);
    expect(images()).toEqual([]);
    expect(placeholders().map((p) => p.textContent)).toEqual(["gone"]);
  });

  it("shows a placeholder when the image fails to load", () => {
    const { editor, images, placeholders } = open("![broken](https://example.com/404.png)\n\nx");
    end(editor);
    images()[0]?.dispatchEvent(new Event("error"));
    expect(images()).toEqual([]);
    expect(placeholders().map((p) => p.textContent)).toEqual(["broken"]);
  });

  it("shows the source when the cursor enters the image", () => {
    const { editor, shown } = open("![A cat](https://example.com/cat.png)\n\nend");
    end(editor);
    editor.setSelection({ anchor: 3 });
    expect(shown()).toBe("![A cat](https://example.com/cat.png)\n\nend");
  });

  it("renders an image inside text inline, revealing only that image", () => {
    const { editor, shown, images } = open("See ![x](https://e.com/x.png) here and **b**");
    end(editor);
    expect(shown()).toBe("See  here and **b**");
    expect(images()).toHaveLength(1);
    editor.setSelection({ anchor: 6 });
    expect(shown()).toBe("See ![x](https://e.com/x.png) here and b");
  });

  it("never changes the text", () => {
    const text = '![a](a.png)\r\n\r\nx ![b](<b c.png> "t") y\r\n';
    const { editor } = open(text, { host: { resolveImageUrl: (s) => s } });
    end(editor);
    editor.setSelection({ anchor: 2 });
    expect(editor.getText()).toBe(text);
  });
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A paste or drop event carrying files, as a browser would send it. */
function fileEvent(type: "paste" | "drop", files: File[], text = "") {
  const data = {
    files,
    types: files.length > 0 ? ["Files"] : ["text/plain"],
    getData: (format: string) => (format === "text/plain" ? text : ""),
  };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: data,
  });
  return event;
}

/** A host that stores saved images under `assets/` and remembers them. */
function savingHost(reference = (file: ImageFile) => `assets/${file.name}`) {
  const saved: { name: string; type: string; origin: string; data: number[] }[] = [];
  const host: HostAdapter = {
    resolveImageUrl: (src) => `asset://${src}`,
    async saveImage(file) {
      saved.push({ name: file.name, type: file.type, origin: file.origin, data: [...file.data] });
      return reference(file);
    },
  };
  return { host, saved };
}

describe("pasting and dropping images", () => {
  it("hands a pasted image to the host and inserts a relative reference at the cursor", async () => {
    const { host, saved } = savingHost(() => "assets/image-1.png");
    const { editor, content } = open("Before  after", { host });
    editor.setSelection({ anchor: 7 });
    const event = fileEvent("paste", [new File([png], "image.png", { type: "image/png" })]);
    content().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(editor.getText()).toBe("Before ![image-1](assets/image-1.png) after"),
    );
    expect(saved).toEqual([
      { name: "image.png", type: "image/png", origin: "paste", data: [...png] },
    ]);
  });

  it("hands dropped image files to the host and inserts one reference per file", async () => {
    const { host, saved } = savingHost();
    const { editor, content } = open("Text\n", { host });
    editor.setSelection({ anchor: 5 });
    content().dispatchEvent(
      fileEvent("drop", [
        new File([png], "one.png", { type: "image/png" }),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
        new File([png], "my photo.jpg", { type: "image/jpeg" }),
      ]),
    );
    await vi.waitFor(() =>
      expect(editor.getText()).toBe(
        "Text\n![one](assets/one.png)\n![my photo](assets/my%20photo.jpg)",
      ),
    );
    expect(saved.map((s) => [s.name, s.origin])).toEqual([
      ["one.png", "drop"],
      ["my photo.jpg", "drop"],
    ]);
  });

  it("keeps the insertion point in place while the image is being saved", async () => {
    let finish: ((reference: string) => void) | undefined;
    const host: HostAdapter = {
      saveImage: () => new Promise((resolve) => (finish = resolve)),
    };
    const { editor, content } = open("ab", { host });
    editor.setSelection({ anchor: 1 });
    content().dispatchEvent(
      fileEvent("paste", [new File([png], "image.png", { type: "image/png" })]),
    );
    editor.setSelection({ anchor: 0 });
    editor.execute("insertText", "X");
    await vi.waitFor(() => expect(finish).toBeDefined());
    editor.execute("insertText", "a");
    finish?.("p.png");
    await vi.waitFor(() => expect(editor.getText()).toBe("Xaa![p](p.png)b"));
  });

  it("leaves pastes without images, and hosts that cannot save, to the default handling", async () => {
    const { host, saved } = savingHost();
    const { editor, content } = open("x", { host });
    editor.setSelection({ anchor: 1 });
    content().dispatchEvent(fileEvent("paste", [], "hello"));
    expect(editor.getText()).toBe("xhello");

    const { editor: other, content: otherContent } = open("x");
    otherContent().dispatchEvent(
      fileEvent("paste", [new File([png], "a.png", { type: "image/png" })]),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(other.getText()).toBe("x");
    expect(saved).toEqual([]);
  });
});

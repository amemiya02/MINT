// Embedded only in the Windows acceptance build. Drive the rendered controls
// and record the visible preview before the normal Save PDF handler runs.
(async () => {
  const directory = document.currentScript.dataset.proof;
  const write = (name, value) =>
    window.__TAURI_INTERNALS__.invoke("write_text_file", {
      path: `${directory}/${name}`,
      text: JSON.stringify(value),
    });
  const errors = new MutationObserver(() => {
    const alert = document.querySelector('[role="alert"]')?.textContent;
    if (alert) {
      errors.disconnect();
      void write("error.json", `${location.pathname}: ${alert}`);
    }
  });
  errors.observe(document, { childList: true, subtree: true, characterData: true });
  if (location.pathname === "/print.html") {
    await write("print-window.json", true);
    return;
  }
  const until = async (description, find) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = find();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${description}: ${document.body.innerText.slice(-500)}`);
  };
  try {
    await until("field notes", () =>
      document.querySelector(".cm-content")?.innerText.includes("Field notes"),
    );
    await write("ready.json", true);
    const dialog = await until("export dialog", () => document.querySelector("dialog[open]"));
    const set = async (label, value) => {
      const control = [...dialog.querySelectorAll("label")].find((node) =>
        node.innerText.includes(label),
      )?.control;
      if (!control) throw new Error(`No control for ${label}`);
      const select = control instanceof HTMLSelectElement;
      const proto = select ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(control, value);
      control.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await set("Paper size", "A5");
    await set("Margins (mm)", "22");
    await set("Font size (pt)", "16");
    const { save, text } = await until("completed preview", () => {
      const save = [...dialog.querySelectorAll("button")].find((button) =>
        button.textContent.includes("Save PDF"),
      );
      const sheets = dialog
        .querySelector("iframe")
        ?.contentDocument?.querySelectorAll(".mint-sheet");
      if (save?.disabled || !save || !sheets?.length || !dialog.querySelector("output")) return;
      const text = [...sheets].map((sheet) => sheet.innerText);
      if (!text.at(-1).includes("Observation-450")) return;
      const image = dialog
        .querySelector("iframe")
        .contentDocument.querySelector('.mint-sheet img[alt="chart"]');
      if (!image?.src.startsWith("data:image/png") || image.naturalWidth !== 1) {
        throw new Error(
          `Preview image failed to embed: ${image?.getAttribute("src")}, width ${image?.naturalWidth}`,
        );
      }
      return { save, text };
    });
    await write("preview.json", text);
    save.click();
  } catch (error) {
    await write("error.json", String(error));
  }
})();

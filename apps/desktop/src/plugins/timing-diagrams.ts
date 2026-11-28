import type { CodeBlockRenderer } from "@mint/editor";
import type { Translate } from "../i18n/index.ts";

const svgNamespace = "http://www.w3.org/2000/svg";

function waveform(name: string, bits: string) {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${name}: ${bits}`);
  svg.setAttribute("viewBox", `0 0 ${bits.length} 24`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "24");
  const line = document.createElementNS(svgNamespace, "path");
  const steps = Array.from(
    bits,
    (bit, i) => `${i === 0 ? "M0 " : "V"}${bit === "0" ? 20 : 4}H${i + 1}`,
  );
  line.setAttribute("d", steps.join(""));
  line.setAttribute("vector-effect", "non-scaling-stroke");
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "2");
  svg.append(line);
  return svg;
}

function invalidDiagram(source: string, message: string) {
  const block = document.createElement("div");
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.className = "text-(--mint-error-fg)";
  alert.textContent = message;
  const code = document.createElement("pre");
  code.className = "whitespace-pre-wrap";
  code.textContent = source;
  block.append(alert, code);
  return block;
}

export function timingRenderer(t: Translate): CodeBlockRenderer {
  return {
    language: "timing",
    render(source) {
      const figure = document.createElement("figure");
      figure.setAttribute("aria-label", t("plugin.timing"));
      figure.className =
        "grid grid-cols-[fit-content(40%)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded border border-(--mint-border) p-3";
      let width = 0;
      for (const [index, line] of source.split("\n").entries()) {
        if (!line.trim()) continue;
        const match = /^([^:]+):\s*([01]+)$/.exec(line.trim());
        const name = match?.[1]?.trim();
        const bits = match?.[2];
        const lineNumber = { line: String(index + 1) };
        if (!name || !bits) return invalidDiagram(source, t("plugin.timingSyntax", lineNumber));
        if (width && bits.length !== width)
          return invalidDiagram(source, t("plugin.timingWidth", lineNumber));
        width = bits.length;
        const label = document.createElement("span");
        label.className = "break-all font-mono";
        label.textContent = name;
        figure.append(label, waveform(name, bits));
      }
      return width ? figure : invalidDiagram(source, t("plugin.timingEmpty"));
    },
  };
}

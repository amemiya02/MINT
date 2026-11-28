import { Previewer } from "pagedjs";

export const paperSizes = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] } as const;
export interface PageLayout {
  paper: keyof typeof paperSizes;
  margin: number;
  font: number;
}
export interface PreviewWindow extends Window {
  paginate(html: string, layout: PageLayout): Promise<{ html: string; count: number }>;
}

// This module runs in its own frame: Paged.js measures in the frame's WebView,
// with the same CSS, embedded fonts and decoded pictures that will be printed.
async function paginate(html: string, { paper, margin, font }: PageLayout) {
  const source = new DOMParser().parseFromString(html, "text/html");
  const [width, height] = paperSizes[paper];
  document.documentElement.dataset.appearance = source.documentElement.dataset.appearance;
  document.title = source.title;
  for (const style of source.querySelectorAll("style")) {
    style.textContent = style.textContent.replace(/@media print\s*\{/g, "@media all {");
    document.head.append(style);
  }
  const style = document.createElement("style");
  style.textContent = `
    body {font-size:${font}pt}
    .mint-document {max-width:none;padding:0}
    img,figure svg {max-height:${height - 2 * margin}mm;object-fit:contain}
    table {max-width:100%;overflow-wrap:anywhere}
  `;
  document.head.append(style);
  const article = source.querySelector("article");
  if (!article) throw new Error("Missing document");
  document.body.replaceChildren(article);
  await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
  await Promise.all([...document.fonts].map((face) => face.load().catch(() => undefined)));
  const content = document.createDocumentFragment();
  content.append(article);
  const pageRules = `
    @page {size:${width}mm ${height}mm;margin:${margin}mm}
    pre,blockquote,figure,img,svg,tr,.katex-display {break-inside:avoid}
    h1,h2,h3,h4,h5,h6 {break-after:avoid}
  `;
  await new Previewer().preview(content, [{ [location.href]: pageRules }], document.body);
  const sheets = document.querySelectorAll(".pagedjs_page");
  for (const sheet of sheets) sheet.classList.add("mint-sheet");

  // Page dimensions and named @page rules may have been inserted via CSSOM.
  // Preserve them when handing the completed pages to the separate print window.
  const snapshot = document.documentElement.cloneNode(true) as HTMLElement;
  for (const node of snapshot.querySelectorAll("script, link")) node.remove();
  const styles = snapshot.querySelectorAll("style");
  for (const [index, style] of document.querySelectorAll("style").entries()) {
    const copy = styles[index];
    if (copy && !style.textContent && style.sheet) {
      copy.textContent = Array.from(style.sheet.cssRules, (rule) => rule.cssText).join("\n");
    }
  }
  const screen = document.createElement("style");
  screen.textContent = `
    html {background:#888}
    .mint-sheet {background:var(--mint-bg,#fff);margin:8px auto}
  `;
  document.head.append(screen);
  const pages = document.querySelector<HTMLElement>(".pagedjs_pages");
  const fitToWidth = () => {
    if (pages)
      pages.style.zoom = String(
        Math.min(1, (document.documentElement.clientWidth - 16) / ((width * 96) / 25.4)),
      );
  };
  fitToWidth();
  window.addEventListener("resize", fitToWidth);
  document.addEventListener("click", (event) => event.preventDefault());
  return { html: `<!doctype html>\n${snapshot.outerHTML}`, count: sheets.length };
}
Object.assign(window, { paginate });

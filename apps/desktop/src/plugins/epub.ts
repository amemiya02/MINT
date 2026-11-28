import { renderHtml } from "@mint/markdown";
import JSZip from "jszip";
import type { ExportSource } from "./export-formats.ts";

function xml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function encodeEpub({ title, text, dialect, language }: ExportSource) {
  const fragment = document.createElement("template");
  fragment.innerHTML = renderHtml(text, dialect);
  // The codec has access to the manuscript only. Preserve image captions without fetching assets.
  for (const image of fragment.content.querySelectorAll("img")) image.replaceWith(image.alt);

  const sections = [...fragment.content.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const ids = new Set([...fragment.content.querySelectorAll("[id]")].map((element) => element.id));
  let next = 1;
  for (const section of sections) {
    if (section.id) continue;
    while (ids.has(`section-${next}`)) next++;
    section.id = `section-${next++}`;
  }
  const links = sections.map(
    (section) =>
      `<li><a href="book.xhtml#${xml(encodeURIComponent(section.id))}">${xml(section.textContent || title)}</a></li>`,
  );
  const languageAttr = xml(language);
  const xhtml = (name: string, body: string) =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${languageAttr}"><head><title>${xml(name)}</title></head><body>${body}</body></html>`;

  const zip = new JSZip();
  // EPUB readers identify the container by its first, uncompressed ZIP entry.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  const properties = [
    fragment.content.querySelector("math") && "mathml",
    fragment.content.querySelector("svg") && "svg",
  ]
    .filter(Boolean)
    .join(" ");
  zip.file(
    "book.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">urn:uuid:${crypto.randomUUID()}</dc:identifier>
<dc:title>${xml(title)}</dc:title><dc:language>${languageAttr}</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="book" href="book.xhtml" media-type="application/xhtml+xml"${properties ? ` properties="${properties}"` : ""}/></manifest>
<spine><itemref idref="book"/></spine></package>`,
  );
  zip.file(
    "nav.xhtml",
    xhtml(
      title,
      `<nav epub:type="toc"><h1>${xml(title)}</h1><ol>${links.length ? links.join("") : `<li><a href="book.xhtml">${xml(title)}</a></li>`}</ol></nav>`,
    ),
  );
  zip.file("book.xhtml", xhtml(title, new XMLSerializer().serializeToString(fragment.content)));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

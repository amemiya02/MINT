import { isMap, isScalar, parseDocument } from "yaml";

/** Splice only the status scalar, keeping comments, the BOM and original line endings. */
export function withStatus(source: string, status: string): string {
  const newline = source.match(/\r?\n/)?.[0] ?? "\n";
  const encoded = JSON.stringify(status);
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(source);
  if (!opening) {
    const bom = source.startsWith("\uFEFF") ? 1 : 0;
    return (
      source.slice(0, bom) +
      ["---", `status: ${encoded}`, "---", ""].join(newline) +
      source.slice(bom)
    );
  }
  const offset = opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(source.slice(offset));
  if (!closing) throw new Error("Missing front matter delimiter");
  const header = source.slice(offset, offset + closing.index);
  const doc = parseDocument(header);
  if (doc.errors.length || (doc.contents && !isMap(doc.contents)))
    throw new Error("Invalid front matter");
  if (!doc.has("status")) {
    if (isMap(doc.contents) && doc.contents.flow)
      throw new Error("Cannot append to a flow mapping");
    return `${source.slice(0, offset)}status: ${encoded}${newline}${source.slice(offset)}`;
  }
  const node = doc.get("status", true);
  if (
    !isScalar(node) ||
    !node.range ||
    node.anchor ||
    node.tag ||
    !["QUOTE_SINGLE", "QUOTE_DOUBLE", "PLAIN"].includes(node.type ?? "")
  )
    throw new Error("Unsupported status scalar");
  const [from, to] = node.range;
  let value = encoded;
  if (node.type === "QUOTE_SINGLE" && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(status))
    value = `'${status.replaceAll("'", "''")}'`;
  if (
    node.type === "PLAIN" &&
    /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(status) &&
    parseDocument(status).toJS() === status
  )
    value = status;
  if (from === to) value = ` ${value} `;
  return source.slice(0, offset + from) + value + source.slice(offset + to);
}

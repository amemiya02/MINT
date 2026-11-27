# MINT plugins

In Settings → Plugins, choose a JSON file containing a MINT version 1 manifest. Review the requested action and choose **Allow access** or **Deny access**. A denied installation can be authorized later. Enabled statistics plugins contribute a named button below the document. The view reads the active draft through the host, including unsaved edits.

A package contains one declarative view. For example, save the following as `character-budget.mint.json`.

```json
{
  "apiVersion": 1,
  "id": "example.character-budget",
  "name": "Character budget",
  "permissions": ["document.read"],
  "statistics": ["characters", "readingMinutes"]
}
```

Use a unique lowercase identifier with letters, digits, dots, or hyphens. The prefix `mint.` belongs to the bundled catalog. The `statistics` array selects and orders the displayed metrics. Available metrics are `words`, `characters`, and `readingMinutes`, using the editor’s rendered-text counts. MINT interprets the manifest as data. The host checks the current installation, enablement, and document grant before computing a view.

A folder plugin contributes a sidebar entry. The bundled **Tag browser** uses the following view. A third-party package can declare it with its own identifier and name.

```json
{
  "apiVersion": 1,
  "id": "example.tags",
  "name": "Browse tags",
  "permissions": ["folder.read"],
  "sidebar": "tags"
}
```

The host reads Markdown documents in the current folder when the authorized view opens. It uses the top-level YAML front matter field `tags`, accepting a string or a sequence such as `tags: [research, travel]`. Select a tag and click a document's relative path to open the original file.

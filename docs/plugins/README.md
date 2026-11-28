# MINT plugins

In Settings → Plugins, choose a JSON file containing a MINT version 1 manifest. Review the requested action and choose **Allow access** or **Deny access**. A denied installation can be authorized later. Enabled statistics plugins contribute a named button below the document. The view reads the active draft through the host, including unsaved edits.

To update an installed package, choose a file with the same identifier. MINT preserves its enabled state and existing grants. If the package adds actions, Settings lists them for approval. Choose **Keep current version** to continue using the installed package with its existing grants. A package can combine statistics, templates, a sidebar and a diagram. Its `permissions` array must contain exactly the actions used by those contributions.

A statistics package can contribute a declarative view. For example, save the following as `character-budget.mint.json`.

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

## Template commands

Install **Writing templates** in Settings → Plugins, then choose **Allow access** to modify the selection in the current document. Open the Command Palette and choose **Insert template · Meeting notes** or **Insert template · Checklist**. If you select text first, the template replaces it. With a caret, the template is inserted there. Undo restores the previous selection content in one step.

To contribute your own template commands, import a JSON manifest with the write permission and a list of uniquely named templates.

```json
{
  "apiVersion": 1,
  "id": "example.review",
  "name": "Review templates",
  "permissions": ["document.write"],
  "templates": [
    { "name": "Review notes", "text": "## Review notes\n\n- " }
  ]
}
```

When a command runs, the host looks up the installed template and its current permission. The editor applies the template to the active selection and saves through the usual document workflow.

## Tag sidebar

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

## Property table

Install **Property table** in Settings → Plugins and allow it to read Markdown documents in the current folder. Open its sidebar entry to see one row per document and a column for each top-level YAML front matter property. A dash marks a missing property. Select a document’s relative path to open its original Markdown. A local package can contribute the same view with `"sidebar": "properties"` and `"permissions": ["folder.read"]`.

## Digital timing diagrams

Install **Digital timing diagrams** in Settings → Plugins and allow it to read the current document. Paste the following example into a document and move the caret outside the block to see the clock and acknowledge signals on a shared time scale.

````markdown
```timing
CLK: 0101
ACK: 0011
```
````

Each row contains a signal name, a colon, and one binary sample per time step. All signals have the same number of samples. Click a waveform to edit its source. An invalid block shows the submitted samples and a diagnostic. Disabling the plugin displays the ordinary fenced code again.

A local MINT package can contribute the same renderer with this manifest.

```json
{
  "apiVersion": 1,
  "id": "example.timing",
  "name": "Bus timing diagrams",
  "permissions": ["document.read"],
  "diagram": "timing"
}
```

## Notion import

In **Settings → Plugins**, install **Notion import** and allow it to read a selected archive and create a folder in a selected destination. Open **File → Import / Export…**, select **Notion import**, and choose a Notion Markdown & CSV or HTML export ZIP. Set the new folder’s name and click **Import** to choose its parent directory. You can start with an empty window.

MINT preserves the page hierarchy and attachment filenames, converts HTML pages to Markdown, and resolves links to included pages. CSV files remain available as attachments. An export ZIP containing numbered Notion ZIP parts is also supported. The import uses a new folder and leaves the ZIP untouched. Choose **Open imported folder** to browse the result. For missing targets, the dialog and the saved text report give the converted document’s path, line number, and original link or attachment reference.

A MINT package can contribute the format under its own name. The host supplies the conversion and checks the installation and grant when it runs. The picker selects the archive, and the destination picker authorizes creating the new folder.

```json
{
  "apiVersion": 1,
  "id": "example.workspace-import",
  "name": "Workspace archive",
  "permissions": ["archive.import"],
  "importer": "notion"
}
```

## EPUB export

Install **EPUB export** in Settings → Plugins and allow it to read the current document. Choose **File → Import / Export… → EPUB** to save a reflowable EPUB 3 book with a linked contents page built from the headings in the active draft. Image captions are included as text.

A package can contribute the same format through the host codec registry. Each enabled format appears once in the Export dialog. The host asks the writer to choose the destination and checks the current document grant before giving the draft to the codec.

```json
{
  "apiVersion": 1,
  "id": "example.ebook",
  "name": "Ebook publishing",
  "permissions": ["document.read"],
  "exportFormat": "epub"
}
```

## Kanban board

Install **Kanban board** in Settings → Plugins to group the current folder’s Markdown documents by their top-level YAML `status`. The board offers To do, In progress, Done, and the status values found in the folder. A document without a status appears under No status. Drag a card to a column or choose a destination from its menu. Select the document name to open it.

Packages can contribute this view with `"sidebar": "kanban"` and `"permissions": ["folder.read", "folder.status.write"]`. The second grant allows the host to update only the status property. Writers can revoke it independently while keeping the board readable.

## Zotero citations

Enable the local API in Zotero's advanced settings, then install **Zotero** in MINT. Grant access to the local library and permission to modify the current selection. Place the caret in a draft, choose **Insert Zotero citation**, and select a title. MINT inserts a Markdown link to that library item. Escape dismisses the picker. The service receives only paginated library reads.

A package can declare this picker with `"citation": "zotero"` and `"permissions": ["zotero.read", "document.write"]`.

## LaTeX export

Install **LaTeX export** in Settings → Plugins and grant access to the current document. Choose **File → Import / Export… → LaTeX** to save the current draft as a standalone UTF-8 `.tex` document. Headings become section commands, lists become LaTeX lists, and inline and display equations preserve their TeX notation. Packages can register this format with `"exportFormat": "latex"` and the `document.read` permission.

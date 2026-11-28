# MINT plugins

In Settings → Plugins, choose a JSON file containing a MINT version 1 manifest. Review the requested action and choose **Allow access** or **Deny access**. A denied installation can be authorized later. Enabled statistics plugins contribute a named button below the document. The view reads the active draft through the host, including unsaved edits.

A statistics package contains one declarative view. For example, save the following as `character-budget.mint.json`.

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

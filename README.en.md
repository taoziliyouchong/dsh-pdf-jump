# dsh-pdf-jump

[中文](README.md) | **English**

Read local PDFs **inside the DSH sidebar**. One install ships two independent tools:

- **`pdf-view` (default)** — renders pages locally for **jumping to a page number** and **whole-document browsing**. The whole-document view fills the list with thumbnails first, swaps each page to full size when it scrolls into view, and has a page box at the top. Works anywhere, even without the native preview.
- **`pdf-open`** — opens the PDF with **DSH's native PDF preview** (client-side rendering, no image generation, no local server, selectable text). Used when you explicitly ask for the native preview, the fastest path, or no images.

Page numbers follow **PDF page order** (1 = first page of the file). The plugin deliberately does not infer the number printed in a footer: manuals often mix whole-book numbering with `chapter-page` numbering.

![Page viewer](assets/screenshot-page.png)

Jump by page number: type it in the toolbar; arrow keys flip pages.

![Whole-document view](assets/screenshot-document.png)

Whole-document view: thumbnails first, full size as each page scrolls into view, with a page box at the top.

## Install

```sh
dsh plugin --profile web add dsh-pdf-jump
```

Before the package is on npm, install straight from GitHub:

```sh
dsh plugin --profile web add github:taoziliyouchong/dsh-pdf-jump
```

Then restart DSH. Replace `web` with your profile name if you use another one.

After the restart a `/pdf` command is registered as well: `/pdf manual 300` returns the link without going through the model.

Requirements: DSH with the host `tools` and `systemPrompt` services (both are part of the normal base composition), Node 22.19+ or 24+.

Compatible with the DSH 0.2.1 line (alpha / rc / stable); 0.3 and later are not guaranteed.

## Use

| You want | Tool |
| --- | --- |
| Open a PDF, jump to page N, browse the whole document | `pdf-view` (default; `page` = PDF page number) |
| Native preview (no images, selectable text) | `pdf-open` |
| Jump to a page inside the whole-document view | Page box at the top, or a `#p40` URL |
| Skip model judgement and open directly | `/pdf <file or fragment> [page]` |
| Extract text / metadata | install the `dsh-pdf` plugin and use its `pdf_info` / `pdf_extract_text` |

Both tools accept an absolute/relative path or a file-name fragment (for example `NB系列 安装手册`); relative paths resolve against the session working directory. Results are one clickable document line: `pdf-open` points at the file itself (opened by the native preview), `pdf-view` points at the local viewer page.

## How it works

- `pdf-open` only resolves the path and returns it for `sidebar_open`; all rendering happens in the DSH client.
- `pdf-view` runs a local HTTP server bound to `127.0.0.1`; it tries ports 8731–8750, reuses a server already started by another DSH process, and starts as soon as the plugin loads. It stays up for the whole DSH session (`idleMinutes: 0`), so links from earlier conversations keep working.
- `pdf-view` renders pages with `pdfjs-dist` and `@napi-rs/canvas` into PNGs cached in the OS temp directory. A call warms the requested page ±2; opening a page warms ±`prefetchWindow` around it, outward one step at a time. Cached pages are served directly without entering the render queue.
- Whole-document view fills the list with 0.8× JPEG thumbnails first (a dozen milliseconds per page) and swaps each page to the full-size PNG as it scrolls into view. Every page carries an anchor (`#p40`); the page box at the top scrolls to the requested page.
- The `/pdf` command always goes through `pdf-view` (single-page mode), starting at page 1 when no page is given; call `pdf-open` directly (or ask for the native preview) when you want the native viewer.
- Viewer URLs are short paths (`/v/<id>/<page>`, `/d/<id>`, `/p/<id>/<page>.png`, `/t/<id>/<page>.jpg`) with no query string; the id maps to the file through a small registry in the temp directory. Combined with the eager start on the same port, a link from an earlier conversation opens again after DSH restarts.
- Nothing is uploaded.

## Configuration

Optional, in the profile patch row (affects `pdf-view` only):

```yaml
- id: dsh-pdf-jump
  name: dsh-pdf-jump
  config:
    port: 8731
    scale: 2
    idleMinutes: 0
    prefetch: true
    prefetchWindow: 6
    roots:
      - D:/manuals
```

| Field | Default | Meaning |
| --- | --- | --- |
| `port` | `8731` | First port to try; the server scans upward for a free or already-running instance |
| `scale` | `2` | Render scale; 2 is roughly 144 dpi |
| `idleMinutes` | `0` | Shut the server down after this many idle minutes; `0` keeps it running for the DSH session |
| `prefetch` | `true` | Warm pages around the current one in the background |
| `prefetchWindow` | `6` | How many pages on each side of the current page to warm |
| `roots` | `[]` | Extra search roots for file-name fragments |

`PDF_JUMP_ROOTS` (environment variable) adds search roots as well, separated by the platform path delimiter (`;` on Windows, `:` elsewhere).

## Limitations

- `pdf-open` relies on DSH's built-in PDF preview; use the default `pdf-view` where that preview is absent.
- `pdf-view` pages are images: no text selection and no full-text search. Install the `dsh-pdf` plugin and use its `pdf_extract_text` when you need the text.
- Rendering needs the `@napi-rs/canvas` prebuilt binary, which covers Windows, macOS and Linux on x64/arm64.

## Troubleshooting

- **The sidebar shows a blank page or "blocked"** (for `pdf-view` URLs): the in-app Sidebar Browser blocks loopback addresses unless they are allowlisted. Add `127.0.0.1:8731` (and whichever port in 8732–8750 is in use), or set *Settings → General → Open chat links in* to the default browser.
- **A link from an older conversation says "connection refused"**: either the viewer port changed (another program holds 8731) or the PDF file moved. Call the tool again for a fresh link; `pdf-open` paths are unaffected.

## Feedback

- Open an issue: https://github.com/taoziliyouchong/dsh-pdf-jump/issues — searchable, and others can help.
- Or reach me on QQ: **2171960697** (mention which plugin you installed when adding the contact).

Please include: DSH version, plugin version, the exact error text, and a screenshot.

## License

MIT

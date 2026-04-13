# Server Files

Every server has a shared file library for documents, images, assets, and anything else the team needs to share.

## Uploading

Click **"Upload file"** or drag-and-drop onto the file list. Files are stored in the server's file library with automatic slug generation for embedding.

## Folders

Organize files into folders. Click **"New folder"** to create one, or upload a file while inside a folder to place it there. The breadcrumb bar shows your current location in the folder tree.

## File Details

Click a file to open the detail panel (right side). You'll see:

- **Metadata** — filename, size, content type, uploader, upload date
- **Description** — click to edit, translates for readers in other languages
- **Image preview** — images render inline in the detail view
- **Comments** — full discussion thread with reactions and translation
- **Actions** — download, copy embed reference, delete

## File Embeds

Every file has a slug. Copy it with **"Copy embed reference"** and paste anywhere:

- `[[file:slug]]` — renders as a file card with icon, name, size, and download button
- `[[img:slug]]` — for images, renders the actual image inline with click-to-lightbox

## Image Lightbox

Click any `[[img:slug]]` embed to open the lightbox — full-size image on the left, description and comments on the right.

## In the Wiki Editor

The wiki editor has built-in file support:

- **"Attach file"** button in the toolbar — opens a file picker
- **Drag-and-drop** — drop a file onto the editor
- **Clipboard paste** — Ctrl+V with an image in the clipboard

Images automatically insert as `[[img:slug]]`, other files as `[[file:slug]]`.

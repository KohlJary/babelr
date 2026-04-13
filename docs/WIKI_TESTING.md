# Wiki Features Testing Checklist

Walk through each section after the wiki enhancement features are
complete. Test on a single instance first, then verify federation
between two Towers using the `./scripts/dev-two-instance.sh` rig.

## Page Hierarchy

- [ ] Create a root-level page. Verify it appears at the top of the sidebar tree.
- [ ] Create a child page (set parent during creation). Verify it appears indented under the parent with a tree arrow.
- [ ] Create a grandchild (child of the child). Verify two levels of nesting in the sidebar.
- [ ] Click a nested page. Verify breadcrumbs show the full ancestry trail (parent > child > current).
- [ ] Click a breadcrumb segment. Verify it navigates to that ancestor page.
- [ ] Reorder pages within siblings (if position editing is exposed in the UI).
- [ ] Move a page to a different parent via the update API or UI. Verify the sidebar tree updates.
- [ ] Delete a parent page. Verify children are handled gracefully (orphaned to root or cascade — document which behavior occurs).
- [ ] **Federation**: create a nested page structure on Tower A. Verify bob on Tower B sees the same tree structure with correct nesting and breadcrumbs.

## Table of Contents

- [ ] Create a page with 3+ headings at different levels (# h1, ## h2, ### h3).
- [ ] Verify the ToC appears above the page content with indented entries matching heading depth.
- [ ] Click a ToC entry. Verify it scrolls to the corresponding heading in the page body.
- [ ] Create a page with 0-1 headings. Verify no ToC appears (threshold is 2+).
- [ ] Edit a page to add/remove headings. Verify the ToC updates on save.
- [ ] **Translation**: view the page in a different language. Verify the ToC reflects the translated heading text (if the translation pipeline translates headings).

## Full-Text Search

- [ ] Create several pages with distinct content.
- [ ] Open the wiki search. Type a word that appears in one page's body (not title).
- [ ] Verify the search results show the matching page with a content preview snippet.
- [ ] Search for a word that appears in multiple pages. Verify all matches are returned.
- [ ] Search for a word that doesn't exist. Verify "no results" feedback.
- [ ] Filter search results by tag. Verify only tagged pages appear.
- [ ] **Federation**: search for content that exists on a remote Tower's wiki. Document whether cross-tower wiki search is supported or scoped to the local shadow pages.

## Comments (Chat-Based)

- [ ] Open a wiki page. Verify a comment thread appears (using the message pipeline — MessageList + MessageInput).
- [ ] Post a comment. Verify it appears in the thread immediately.
- [ ] Post a comment as a different user. Verify both users see each other's comments in real time.
- [ ] Add a reaction to a comment. Verify it renders.
- [ ] Reply to a comment in a thread. Verify threaded replies work.
- [ ] **Translation**: post a comment in a different language. Verify it translates for the reader.
- [ ] **Federation**: alice posts a comment on a wiki page. Verify bob on Tower B sees the comment (if wiki comments federate — they should since they use the message pipeline with a channel context).

## Revision History

- [ ] Create a page. Verify revision 1 is recorded.
- [ ] Edit the page 3 times with different content. Verify 4 revisions exist (1 create + 3 edits).
- [ ] Open the revision history viewer. Verify it shows all revisions with editor name, timestamp, and optional summary.
- [ ] Click a revision to view its content. Verify the old content renders correctly.
- [ ] Restore an older revision. Verify the page content reverts and a new revision (N+1) is created with "Restored from revision X" as the summary.
- [ ] **Diff view** (if implemented): compare two revisions side-by-side. Verify additions/deletions are highlighted.

## Wiki Attachments (via Server Files)

- [ ] In the wiki editor, use the file picker / drag-and-drop to insert a file reference.
- [ ] Verify `[[file:slug]]` is inserted at the cursor position.
- [ ] Save and view the page. Verify the file embed renders inline (with type icon, filename, size, download link).
- [ ] Insert an image file. Verify it renders as an inline image preview (not just a file card).
- [ ] Click the file embed. Verify it navigates to the Files panel with the file detail open.
- [ ] Paste an image from the clipboard into the editor. Verify it auto-uploads and inserts the embed (if clipboard paste is implemented).

## Page Templates

- [ ] Open the "New page" flow. Verify a template picker is shown (if templates are implemented).
- [ ] Select "Meeting Notes" template. Verify the editor pre-fills with the template content.
- [ ] Select "Decision Record" template. Verify different template content.
- [ ] Create a custom template from an existing page. Verify it appears in the template picker.
- [ ] **Translation**: select a template while your preferred language is non-English. Verify the template content is translated.

## Content Enhancements

- [ ] Create a page with a fenced code block tagged with a language (e.g. ```typescript). Verify syntax highlighting renders.
- [ ] Create a page with a callout block (> [!NOTE] or > [!WARNING]). Verify it renders as a styled callout.
- [ ] Create a page with task lists (- [ ] / - [x]). Verify checkboxes render (interactive toggle if supported).
- [ ] Verify inline code, tables, images, links, and blockquotes all render correctly.

## Navigation Improvements

- [ ] Check for a "Recently edited" section in the sidebar (if implemented). Verify it shows the last N pages with editor and timestamp.
- [ ] Check for an "All pages" alphabetical index view (if implemented).
- [ ] Check for "Orphaned pages" — pages with no backlinks. Verify they're surfaced for admin attention.
- [ ] View page statistics (if implemented): view count, edit count, last editor.

## Export

- [ ] Export a single page as markdown. Verify the downloaded .md file matches the page content.
- [ ] Export a single page as PDF (if implemented). Verify the PDF renders the full page with formatting.
- [ ] Export the entire wiki as a zip. Verify the zip contains markdown files preserving the folder structure from page hierarchy.
- [ ] Verify [[wiki:slug]] refs in exported markdown are converted to relative file links.

## Import

- [ ] Import an Obsidian vault (folder of .md files with [[wikilinks]]). Verify pages are created with correct titles, content, and [[wiki:slug]] refs resolved.
- [ ] Import a Confluence XML space export (if implemented). Verify page hierarchy, content, and attachments are preserved.
- [ ] Import a Notion markdown+CSV export (if implemented). Verify page tree and content.
- [ ] Verify re-importing the same source is idempotent (pages updated, not duplicated).
- [ ] Verify imported pages have correct parentId nesting from the source's hierarchy.

## Cross-Cutting Concerns

- [ ] **Translation**: every text surface (titles, content, comments, ToC, breadcrumbs, search results) should translate when the reader's preferred language differs from the source.
- [ ] **Federation**: all hierarchy, content, and metadata should sync to remote Towers via Article activities. Verify the sidebar tree on a remote Tower matches the origin.
- [ ] **Embeds**: [[wiki:slug]] embeds work from chat messages, calendar events, file descriptions, and other wiki pages. Cross-tower [[server@tower:wiki:slug]] embeds resolve and render.
- [ ] **Permissions**: VIEW_WIKI, CREATE_WIKI_PAGES, MANAGE_WIKI all enforced. Non-members can't see wiki content. Creator override works for own pages.

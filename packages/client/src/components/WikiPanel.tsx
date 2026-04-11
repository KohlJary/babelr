// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback, useRef } from 'react';
import type { WikiPageSummary, WikiPageView, WikiBacklinkView } from '@babelr/shared';
import { useWikiPages } from '../hooks/useWikiPages';
import { useWikiTranslation } from '../hooks/useWikiTranslation';
import { useTranslationSettings } from '../hooks/useTranslationSettings';
import { useT } from '../i18n/I18nProvider';
import { renderWikiMarkdown } from '../utils/markdown';
import * as api from '../api';

interface WikiPanelProps {
  serverId: string;
  serverName?: string;
  /** Slug to open on mount, overriding the default "first page" behavior */
  initialSlug?: string | null;
  /** Initial content to seed a new page with (e.g. from a message) */
  initialDraft?: { title?: string; content?: string } | null;
  onClose: () => void;
}

type Mode = 'view' | 'edit' | 'create';

export function WikiPanel({ serverId, serverName, initialSlug, initialDraft, onClose }: WikiPanelProps) {
  const t = useT();
  const { pages, loading, error, reload, getPage, createPage, updatePage, deletePage } =
    useWikiPages(serverId);
  const { settings: translationSettings } = useTranslationSettings();

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<WikiPageView | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [backlinks, setBacklinks] = useState<WikiBacklinkView[]>([]);
  const [showOriginal, setShowOriginal] = useState(false);

  // Translate the current page's content lazily. Only runs in view
  // mode — edit/create show the user's literal draft.
  const translate = useWikiTranslation(
    currentPage && mode === 'view' ? currentPage.content : '',
    translationSettings,
    Boolean(currentPage) && mode === 'view',
  );

  // Edit form state
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftSummary, setDraftSummary] = useState('');
  const [previewOn, setPreviewOn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (slug: string) => {
      const page = await getPage(slug);
      setCurrentPage(page);
      setMode('view');
      setShowOriginal(false);
      if (page) {
        try {
          const res = await api.getWikiBacklinks(serverId, slug);
          setBacklinks(res.backlinks);
        } catch {
          setBacklinks([]);
        }
      } else {
        setBacklinks([]);
      }
    },
    [getPage, serverId],
  );

  // Seed create mode from initialDraft (e.g. 'convert message to page')
  useEffect(() => {
    if (!initialDraft) return;
    setDraftTitle(initialDraft.title ?? '');
    setDraftContent(initialDraft.content ?? '');
    setDraftSummary('');
    setPreviewOn(false);
    setSaveError(null);
    setMode('create');
  }, [initialDraft]);

  // Remember which initialSlug we've already applied so subsequent
  // in-panel navigations don't get snapped back to the prop value.
  // We re-apply only when the caller passes a *new* initialSlug (e.g.
  // clicking a wiki ref in a message while the panel is already open).
  const lastAppliedInitialSlug = useRef<string | null>(null);

  // Auto-select first page when the list loads — or honor initialSlug
  // if the caller passed a new one. Skip entirely if we're mid-create.
  useEffect(() => {
    if (mode === 'create') return;
    if (initialSlug && initialSlug !== lastAppliedInitialSlug.current) {
      lastAppliedInitialSlug.current = initialSlug;
      setSelectedSlug(initialSlug);
      void loadPage(initialSlug);
      return;
    }
    if (selectedSlug || pages.length === 0) return;
    const first = pages[0];
    setSelectedSlug(first.slug);
    void loadPage(first.slug);
  }, [pages, selectedSlug, loadPage, initialSlug, mode]);

  const handleSelect = (summary: WikiPageSummary) => {
    setSelectedSlug(summary.slug);
    setMode('view');
    setSaveError(null);
    void loadPage(summary.slug);
  };

  /**
   * Intercept clicks on rendered `[[slug]]` refs inside this panel's
   * own markdown (both view and preview mode). The global handler on
   * ChatView opens the panel for refs clicked outside, but once the
   * panel is already open we want to navigate in-place instead of
   * re-opening, so we catch the click locally first.
   */
  const handleContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest?.('a[href^="#wiki/"]') as HTMLAnchorElement | null;
    if (!anchor) return;
    e.preventDefault();
    e.stopPropagation();
    const slug = decodeURIComponent(anchor.getAttribute('href')!.slice('#wiki/'.length));
    setSelectedSlug(slug);
    setMode('view');
    setSaveError(null);
    void loadPage(slug);
  };

  const handleCopyLink = async () => {
    if (!currentPage) return;
    const text = `[[${currentPage.slug}]]`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can fail in insecure contexts — fall back to a
      // temporary textarea selection.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing more we can do */
      }
      document.body.removeChild(ta);
    }
  };

  const beginCreate = () => {
    setDraftTitle('');
    setDraftContent('');
    setDraftSummary('');
    setPreviewOn(false);
    setSaveError(null);
    setMode('create');
  };

  const beginEdit = () => {
    if (!currentPage) return;
    setDraftTitle(currentPage.title);
    setDraftContent(currentPage.content);
    setDraftSummary('');
    setPreviewOn(false);
    setSaveError(null);
    setMode('edit');
  };

  const cancelEdit = () => {
    setMode(currentPage ? 'view' : 'view');
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!draftTitle.trim()) {
      setSaveError(t('wiki.pageTitle') + ' required');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (mode === 'create') {
        const created = await createPage({ title: draftTitle.trim(), content: draftContent });
        if (created) {
          setSelectedSlug(created.slug);
          setCurrentPage(created);
          setMode('view');
        }
      } else if (mode === 'edit' && currentPage) {
        const updated = await updatePage(currentPage.slug, {
          title: draftTitle.trim(),
          content: draftContent,
          summary: draftSummary.trim() || undefined,
        });
        if (updated) {
          setCurrentPage(updated);
          setMode('view');
        }
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('wiki.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!currentPage) return;
    if (!confirm(t('wiki.deleteConfirm'))) return;
    try {
      await deletePage(currentPage.slug);
      setCurrentPage(null);
      setSelectedSlug(null);
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('wiki.failedToDelete'));
    }
  };

  const panelTitle = serverName
    ? `${t('wiki.serverWiki')} — ${serverName}`
    : t('wiki.serverWiki');

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-panel settings-panel-wide wiki-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2>{panelTitle}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="wiki-body">
          <aside className="wiki-sidebar">
            <button className="auth-submit wiki-new-btn" onClick={beginCreate}>
              + {t('wiki.createPage')}
            </button>
            <h3 className="friends-section-header">{t('wiki.pages')}</h3>
            {loading && <div className="sidebar-empty">{t('wiki.loading')}</div>}
            {error && <div className="dm-lookup-error">{error}</div>}
            {!loading && !error && pages.length === 0 && (
              <div className="sidebar-empty">{t('wiki.noPages')}</div>
            )}
            <ul className="wiki-page-list">
              {pages.map((p) => (
                <li key={p.id}>
                  <button
                    className={`wiki-page-item ${selectedSlug === p.slug ? 'selected' : ''}`}
                    onClick={() => handleSelect(p)}
                  >
                    {p.title || t('wiki.untitled')}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <main className="wiki-content">
            {mode === 'view' && !currentPage && (
              <div className="sidebar-empty">{t('wiki.selectPage')}</div>
            )}

            {mode === 'view' && currentPage && (
              <>
                <div className="wiki-content-header">
                  <h1 className="wiki-page-title">{currentPage.title}</h1>
                  <div className="wiki-content-actions">
                    <button className="voice-control-btn" onClick={beginEdit}>
                      {t('wiki.editPage')}
                    </button>
                    <button className="voice-control-btn leave" onClick={handleDelete}>
                      {t('wiki.deletePage')}
                    </button>
                  </div>
                </div>
                <div className="wiki-content-meta">
                  <span className="wiki-slug-display">
                    <code>[[{currentPage.slug}]]</code>
                    <button
                      type="button"
                      className="wiki-slug-copy"
                      onClick={handleCopyLink}
                      title={t('wiki.copyLink')}
                    >
                      📋
                    </button>
                  </span>
                  <span className="wiki-meta-sep">·</span>
                  {t('wiki.lastEditedBy', {
                    user:
                      currentPage.lastEditedBy.displayName ??
                      currentPage.lastEditedBy.preferredUsername,
                  })}
                  {translate.isTranslating && (
                    <>
                      <span className="wiki-meta-sep">·</span>
                      <span className="wiki-translating">{t('wiki.translating')}</span>
                    </>
                  )}
                  {translate.anyTranslated && translate.translatedContent && (
                    <>
                      <span className="wiki-meta-sep">·</span>
                      <button
                        type="button"
                        className="wiki-translation-toggle"
                        onClick={() => setShowOriginal((v) => !v)}
                        title={
                          showOriginal ? t('wiki.showTranslated') : t('wiki.showOriginal')
                        }
                      >
                        {showOriginal
                          ? t('wiki.showTranslated')
                          : t('wiki.translatedBadge', {
                              langs: Array.from(new Set(translate.detectedLanguages)).join(', '),
                            })}
                      </button>
                    </>
                  )}
                </div>
                {currentPage.content.trim() ? (
                  <div
                    className="wiki-content-body"
                    onClick={handleContentClick}
                    dangerouslySetInnerHTML={{
                      __html: renderWikiMarkdown(
                        !showOriginal && translate.translatedContent
                          ? translate.translatedContent
                          : currentPage.content,
                      ),
                    }}
                  />
                ) : (
                  <div className="sidebar-empty">{t('wiki.emptyContent')}</div>
                )}

                {backlinks.length > 0 && (
                  <section className="wiki-backlinks">
                    <h3 className="friends-section-header">{t('wiki.backlinks')}</h3>
                    <ul className="wiki-backlinks-list">
                      {backlinks.map((bl, idx) => {
                        if (bl.sourceType === 'page' && bl.page) {
                          return (
                            <li key={`p-${bl.page.id}-${idx}`}>
                              <button
                                className="wiki-backlink-item"
                                onClick={() => {
                                  setSelectedSlug(bl.page!.slug);
                                  void loadPage(bl.page!.slug);
                                }}
                              >
                                <span className="wiki-backlink-icon">📄</span>
                                <span className="wiki-backlink-title">{bl.page.title}</span>
                              </button>
                            </li>
                          );
                        }
                        if (bl.sourceType === 'message' && bl.message) {
                          const author =
                            bl.message.author.displayName ?? bl.message.author.preferredUsername;
                          const channel = bl.message.channelName ?? '?';
                          return (
                            <li key={`m-${bl.message.id}-${idx}`}>
                              <div className="wiki-backlink-item message">
                                <span className="wiki-backlink-icon">💬</span>
                                <div className="wiki-backlink-message">
                                  <div className="wiki-backlink-meta">
                                    {author} · #{channel}
                                  </div>
                                  <div className="wiki-backlink-snippet">
                                    {bl.message.content.slice(0, 140)}
                                  </div>
                                </div>
                              </div>
                            </li>
                          );
                        }
                        return null;
                      })}
                    </ul>
                  </section>
                )}
              </>
            )}

            {(mode === 'edit' || mode === 'create') && (
              <div className="wiki-edit-form">
                <label className="auth-label">
                  {t('wiki.pageTitle')}
                  <input
                    className="auth-input"
                    type="text"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    placeholder={t('wiki.pageTitlePlaceholder')}
                    autoFocus
                  />
                </label>

                <div className="wiki-edit-toolbar">
                  <button
                    className={`voice-control-btn ${!previewOn ? 'active-on' : ''}`}
                    onClick={() => setPreviewOn(false)}
                    type="button"
                  >
                    {t('wiki.write')}
                  </button>
                  <button
                    className={`voice-control-btn ${previewOn ? 'active-on' : ''}`}
                    onClick={() => setPreviewOn(true)}
                    type="button"
                  >
                    {t('wiki.preview')}
                  </button>
                </div>

                {previewOn ? (
                  <div
                    className="wiki-content-body wiki-preview"
                    onClick={handleContentClick}
                    dangerouslySetInnerHTML={{ __html: renderWikiMarkdown(draftContent) }}
                  />
                ) : (
                  <textarea
                    className="auth-input wiki-content-textarea"
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    placeholder={t('wiki.pageContentPlaceholder')}
                    rows={20}
                  />
                )}

                {mode === 'edit' && (
                  <label className="auth-label">
                    {t('wiki.editSummary')}
                    <input
                      className="auth-input"
                      type="text"
                      value={draftSummary}
                      onChange={(e) => setDraftSummary(e.target.value)}
                      placeholder={t('wiki.editSummaryPlaceholder')}
                    />
                  </label>
                )}

                {saveError && <div className="dm-lookup-error">{saveError}</div>}

                <div className="wiki-edit-actions">
                  <button className="voice-control-btn" onClick={cancelEdit} disabled={saving}>
                    {t('wiki.cancel')}
                  </button>
                  <button
                    className="auth-submit"
                    onClick={handleSave}
                    disabled={saving || !draftTitle.trim()}
                  >
                    {t('wiki.savePage')}
                  </button>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type {
  WikiPageSummary,
  WikiPageView,
  WikiBacklinkView,
  WikiSettingsView,
  IdiomAnnotation,
} from '@babelr/shared';
import { useWikiPages } from '../hooks/useWikiPages';
import { useWikiTranslation, type TranslatedChunk } from '../hooks/useWikiTranslation';
import { useTranslationSettings } from '../hooks/useTranslationSettings';
import { useT } from '../i18n/I18nProvider';
import type { UIStringKey } from '@babelr/shared';
import { renderWithEmbeds } from '../utils/render-with-embeds';
import { extractHeadings } from '../utils/markdown';
import { useWebSocket } from '../hooks/useWebSocket';
import type { WsServerMessage } from '@babelr/shared';
import type { MessageEmbedView, EventEmbedView, FileEmbedView } from '@babelr/shared';
import * as api from '../api';

interface WikiPanelProps {
  serverId: string;
  serverName?: string;
  /** Caller's role on this server — controls access to home-page controls */
  callerRole?: string;
  /** Slug to open on mount, overriding the default "first page" behavior */
  initialSlug?: string | null;
  /** Initial content to seed a new page with (e.g. from a message) */
  initialDraft?: { title?: string; content?: string } | null;
  /** Called when the user clicks an inline message embed inside a wiki page. */
  onNavigateMessageEmbed?: (embed: MessageEmbedView) => void;
  /** Called when the user clicks an inline event embed inside a wiki page. */
  onNavigateEventEmbed?: (embed: EventEmbedView) => void;
  /** Called when the user clicks an inline file embed inside a wiki page. */
  onNavigateFileEmbed?: (embed: FileEmbedView) => void;
  onClose: () => void;
}

type Mode = 'view' | 'edit' | 'create';

function ConfidenceDot({
  confidence,
  label,
  title,
}: {
  confidence: number;
  label: string;
  title: string;
}) {
  const color = confidence > 0.8 ? '#22c55e' : confidence > 0.5 ? '#eab308' : '#ef4444';
  return (
    <span className="wiki-confidence" title={title}>
      <span className="wiki-confidence-dot" style={{ backgroundColor: color }} />
      <span className="wiki-confidence-label">{label}</span>
    </span>
  );
}

function ChunkIndicators({
  chunk,
  t,
}: {
  chunk: TranslatedChunk;
  t: (key: UIStringKey, values?: Record<string, string | number>) => string;
}) {
  const [idiomsOpen, setIdiomsOpen] = useState(false);
  if (chunk.kind !== 'prose' || !chunk.cached || chunk.cached.skipped) return null;
  const meta = chunk.cached.metadata;
  if (!meta) return null;
  const confidenceLabel =
    meta.confidence > 0.8
      ? t('wiki.confidenceHigh')
      : meta.confidence > 0.5
        ? t('wiki.confidenceMedium')
        : t('wiki.confidenceLow');
  const idioms: IdiomAnnotation[] = meta.idioms ?? [];
  return (
    <div className="wiki-chunk-indicators">
      <ConfidenceDot
        confidence={meta.confidence}
        label={`${meta.register} · ${meta.intent}`}
        title={`${confidenceLabel} (${Math.round(meta.confidence * 100)}%)`}
      />
      {idioms.length > 0 && (
        <button
          type="button"
          className="wiki-idiom-toggle"
          onClick={() => setIdiomsOpen((v) => !v)}
        >
          {t('wiki.idiomsFlagged', { count: idioms.length })}
          <span className="wiki-idiom-arrow">{idiomsOpen ? '▼' : '▶'}</span>
        </button>
      )}
      {idiomsOpen && idioms.length > 0 && (
        <div className="wiki-idiom-list">
          {idioms.map((idiom, i) => (
            <div key={i} className="wiki-idiom-entry">
              <div className="wiki-idiom-original">
                <span className="wiki-idiom-label">{t('wiki.idiomLabel')}:</span>{' '}
                <em>{idiom.original}</em>
                {idiom.equivalent && (
                  <>
                    {' → '}
                    <em>{idiom.equivalent}</em>
                  </>
                )}
              </div>
              <div className="wiki-idiom-explanation">{idiom.explanation}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WikiPanel({
  serverId,
  serverName,
  callerRole,
  initialSlug,
  initialDraft,
  onNavigateMessageEmbed,
  onNavigateEventEmbed,
  onNavigateFileEmbed,
  onClose,
}: WikiPanelProps) {
  const t = useT();
  const { pages, loading, error, reload, getPage, createPage, updatePage, deletePage } =
    useWikiPages(serverId);
  const { settings: translationSettings } = useTranslationSettings();

  const isMod = ['owner', 'admin', 'moderator'].includes(callerRole ?? '');

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<WikiPageView | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [backlinks, setBacklinks] = useState<WikiBacklinkView[]>([]);
  const [showOriginal, setShowOriginal] = useState(false);

  // Live-reload wiki page list when another user (or federation)
  // creates, edits, or deletes a page on this server.
  const handleWikiWs = useCallback(
    (msg: WsServerMessage) => {
      if (msg.type === 'wiki:page-changed' && msg.payload.serverId === serverId) {
        void reload();
        if (msg.payload.action === 'updated' && msg.payload.slug === selectedSlug) {
          void getPage(msg.payload.slug).then(setCurrentPage);
        }
        if (msg.payload.action === 'deleted' && msg.payload.slug === selectedSlug) {
          setSelectedSlug(null);
          setCurrentPage(null);
        }
      }
    },
    [serverId, reload, selectedSlug, getPage],
  );
  useWebSocket(true, handleWikiWs);

  // Wiki-level settings (home page). Fetched on mount and refreshed
  // whenever the caller changes it.
  const [wikiSettings, setWikiSettings] = useState<WikiSettingsView | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getWikiSettings(serverId)
      .then((res) => {
        if (!cancelled) setWikiSettings(res.settings);
      })
      .catch(() => {
        if (!cancelled) setWikiSettings({ homeSlug: null });
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  // Translate the current page's content lazily. Only runs in view
  // mode — edit/create show the user's literal draft.
  const translate = useWikiTranslation(
    currentPage && mode === 'view' ? currentPage.content : '',
    translationSettings,
    Boolean(currentPage) && mode === 'view',
  );

  // Sidebar filter state. `searchQuery` is the title/slug substring
  // filter; `activeTag` is an optional tag filter that narrows further.
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Edit form state
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftParentId, setDraftParentId] = useState<string | null>(null);
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftTagInput, setDraftTagInput] = useState('');
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
    setDraftTags([]);
    setDraftTagInput('');
    setDraftSummary('');
    setPreviewOn(false);
    setSaveError(null);
    setMode('create');
  }, [initialDraft]);

  // Track which initialSlug we've already applied so subsequent
  // in-panel navigations don't get snapped back to the prop value.
  const lastAppliedInitialSlug = useRef<string | null>(null);

  // Auto-select on list load:
  // 1. explicit initialSlug (from a wiki-ref click) always wins
  // 2. otherwise the server-configured home page if set
  // 3. otherwise the first page by recency
  // Skip entirely if we're mid-create.
  useEffect(() => {
    if (mode === 'create') return;
    if (initialSlug && initialSlug !== lastAppliedInitialSlug.current) {
      lastAppliedInitialSlug.current = initialSlug;
      setSelectedSlug(initialSlug);
      void loadPage(initialSlug);
      return;
    }
    if (selectedSlug || pages.length === 0) return;
    // Wait for settings to resolve before picking a default — avoids a
    // flash of the "first page" before the home page loads in.
    if (wikiSettings === null) return;
    const homeMatch = wikiSettings.homeSlug
      ? pages.find((p) => p.slug === wikiSettings.homeSlug)
      : undefined;
    const chosen = homeMatch ?? pages[0];
    setSelectedSlug(chosen.slug);
    void loadPage(chosen.slug);
  }, [pages, selectedSlug, loadPage, initialSlug, mode, wikiSettings]);

  const handleSelect = (summary: WikiPageSummary) => {
    setSelectedSlug(summary.slug);
    setMode('view');
    setSaveError(null);
    void loadPage(summary.slug);
  };

  /**
   * Intercept clicks on rendered `[[slug]]` refs inside this panel's
   * own markdown. The global handler on ChatView opens the panel for
   * refs clicked outside, but once the panel is already open we want
   * to navigate in-place instead of re-opening.
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

  const beginCreate = (parentId?: string | null) => {
    setDraftTitle('');
    setDraftContent('');
    setDraftTags([]);
    setDraftTagInput('');
    setDraftSummary('');
    setDraftParentId(parentId ?? null);
    setPreviewOn(false);
    setSaveError(null);
    setMode('create');
  };

  const beginEdit = () => {
    if (!currentPage) return;
    setDraftTitle(currentPage.title);
    setDraftContent(currentPage.content);
    setDraftTags(currentPage.tags ?? []);
    setDraftTagInput('');
    setDraftSummary('');
    setPreviewOn(false);
    setSaveError(null);
    setMode('edit');
  };

  const cancelEdit = () => {
    setMode('view');
    setSaveError(null);
  };

  const commitTagFromInput = () => {
    const cleaned = draftTagInput.trim().toLowerCase().slice(0, 48);
    if (!cleaned) return;
    if (draftTags.includes(cleaned)) {
      setDraftTagInput('');
      return;
    }
    if (draftTags.length >= 32) return;
    setDraftTags([...draftTags, cleaned]);
    setDraftTagInput('');
  };

  const removeTag = (tag: string) => setDraftTags(draftTags.filter((t) => t !== tag));

  const handleSave = async () => {
    if (!draftTitle.trim()) {
      setSaveError(t('wiki.pageTitle') + ' required');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (mode === 'create') {
        const created = await createPage({
          title: draftTitle.trim(),
          content: draftContent,
          tags: draftTags,
          parentId: draftParentId,
        });
        if (created) {
          setSelectedSlug(created.slug);
          setCurrentPage(created);
          setMode('view');
        }
      } else if (mode === 'edit' && currentPage) {
        const updated = await updatePage(currentPage.slug, {
          title: draftTitle.trim(),
          content: draftContent,
          tags: draftTags,
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

  const handleSetAsHome = async () => {
    if (!currentPage) return;
    try {
      const nextSlug = wikiSettings?.homeSlug === currentPage.slug ? null : currentPage.slug;
      const res = await api.updateWikiSettings(serverId, { homeSlug: nextSlug });
      setWikiSettings(res.settings);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to update home page');
    }
  };

  // Derived sidebar state: tag counts, filtered page list.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pages) {
      for (const tag of p.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }, [pages]);

  const filteredPages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return pages.filter((p) => {
      if (q) {
        const hay = `${p.title} ${p.slug}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (activeTag && !(p.tags ?? []).includes(activeTag)) return false;
      return true;
    });
  }, [pages, searchQuery, activeTag]);

  const panelTitle = serverName
    ? `${t('wiki.serverWiki')} — ${serverName}`
    : t('wiki.serverWiki');

  // Page-level register aggregate for the meta row. Collapses all
  // registers seen across translated prose chunks into a sorted
  // deduplicated list.
  const pageRegisters = useMemo(() => {
    const out = new Set<string>();
    for (const c of translate.chunks) {
      if (c.cached?.metadata && !c.cached.skipped) {
        out.add(c.cached.metadata.register);
      }
    }
    return Array.from(out).sort();
  }, [translate.chunks]);

  const isCurrentPageHome = Boolean(
    currentPage && wikiSettings?.homeSlug === currentPage.slug,
  );

  return (
    <div className="inline-main-view wiki-panel">
      <div className="inline-main-header">
        <h2>{panelTitle}</h2>
        <button className="settings-close" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="wiki-body">
          <aside className="wiki-sidebar">
            <button className="auth-submit wiki-new-btn" onClick={() => beginCreate()}>
              + {t('wiki.createPage')}
            </button>

            <input
              className="auth-input wiki-search-input"
              type="search"
              placeholder={t('wiki.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            {tagCounts.size > 0 && (
              <div className="wiki-tag-filter">
                <h3 className="friends-section-header">{t('wiki.tags')}</h3>
                <div className="wiki-tag-filter-chips">
                  {activeTag && (
                    <button
                      type="button"
                      className="wiki-tag-chip active clearable"
                      onClick={() => setActiveTag(null)}
                      title={t('wiki.clearTagFilter')}
                    >
                      ✕ {activeTag}
                    </button>
                  )}
                  {Array.from(tagCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([tag, count]) => (
                      <button
                        type="button"
                        key={tag}
                        className={`wiki-tag-chip ${activeTag === tag ? 'active' : ''}`}
                        onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                      >
                        {tag} <span className="wiki-tag-count">{count}</span>
                      </button>
                    ))}
                </div>
              </div>
            )}

            <h3 className="friends-section-header">{t('wiki.pages')}</h3>
            {loading && <div className="sidebar-empty">{t('wiki.loading')}</div>}
            {error && <div className="dm-lookup-error">{error}</div>}
            {!loading && !error && pages.length === 0 && (
              <div className="sidebar-empty">{t('wiki.noPages')}</div>
            )}
            {!loading && !error && pages.length > 0 && filteredPages.length === 0 && (
              <div className="sidebar-empty">{t('wiki.noSearchResults')}</div>
            )}
            <ul className="wiki-page-list">
              {(() => {
                // Build tree from flat list. Group by parentId, then
                // render recursively. Pages without a parent (or whose
                // parent isn't in filteredPages) are roots.
                const byParent = new Map<string | null, typeof filteredPages>();
                const idSet = new Set(filteredPages.map((p) => p.id));
                for (const p of filteredPages) {
                  // If the parent isn't in the filtered set, treat as root.
                  const key = p.parentId && idSet.has(p.parentId) ? p.parentId : null;
                  const group = byParent.get(key) ?? [];
                  group.push(p);
                  byParent.set(key, group);
                }

                function renderTree(parentId: string | null, depth: number): React.ReactNode[] {
                  const children = byParent.get(parentId);
                  if (!children) return [];
                  return children
                    .sort((a, b) => a.position - b.position)
                    .map((p) => {
                      const isHome = wikiSettings?.homeSlug === p.slug;
                      const hasChildren = byParent.has(p.id);
                      return (
                        <li key={p.id}>
                          <button
                            className={`wiki-page-item ${selectedSlug === p.slug ? 'selected' : ''}`}
                            style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
                            onClick={() => handleSelect(p)}
                          >
                            {hasChildren && <span className="wiki-tree-arrow">&#9662;</span>}
                            {isHome && (
                              <span className="wiki-home-indicator" title={t('wiki.home')}>
                                {t('wiki.homePageBadge')}
                              </span>
                            )}
                            {p.title || t('wiki.untitled')}
                          </button>
                          {hasChildren && (
                            <ul className="wiki-page-list wiki-page-subtree">
                              {renderTree(p.id, depth + 1)}
                            </ul>
                          )}
                        </li>
                      );
                    });
                }

                return renderTree(null, 0);
              })()}
            </ul>
          </aside>

          <main className="wiki-content">
            {mode === 'view' && !currentPage && (
              <div className="sidebar-empty">{t('wiki.selectPage')}</div>
            )}

            {mode === 'view' && currentPage && (
              <>
                {/* Breadcrumb trail from root to current page */}
                {currentPage.parentId && (
                  <div className="wiki-breadcrumb">
                    {(() => {
                      const trail: { slug: string; title: string }[] = [];
                      let pid: string | null = currentPage.parentId;
                      while (pid) {
                        const parent = pages.find((p) => p.id === pid);
                        if (!parent) break;
                        trail.unshift({ slug: parent.slug, title: parent.title });
                        pid = parent.parentId;
                      }
                      return trail.map((crumb, i) => (
                        <span key={crumb.slug}>
                          {i > 0 && <span className="wiki-breadcrumb-sep"> / </span>}
                          <button
                            className="wiki-breadcrumb-link"
                            onClick={() => handleSelect(pages.find((p) => p.slug === crumb.slug)!)}
                          >
                            {crumb.title}
                          </button>
                        </span>
                      ));
                    })()}
                    <span className="wiki-breadcrumb-sep"> / </span>
                    <span className="wiki-breadcrumb-current">{currentPage.title}</span>
                  </div>
                )}
                <div className="wiki-content-header">
                  <h1 className="wiki-page-title">
                    {isCurrentPageHome && (
                      <span className="wiki-home-indicator" title={t('wiki.home')}>
                        {t('wiki.homePageBadge')}
                      </span>
                    )}
                    {currentPage.title}
                  </h1>
                  <div className="wiki-content-actions">
                    {isMod && (
                      <button
                        className="voice-control-btn"
                        onClick={handleSetAsHome}
                        title={
                          isCurrentPageHome
                            ? t('wiki.unsetHome')
                            : t('wiki.setAsHome')
                        }
                      >
                        {isCurrentPageHome ? t('wiki.unsetHome') : t('wiki.setAsHome')}
                      </button>
                    )}
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
                      <span className="wiki-translating">
                        {translate.progressTotal > 1
                          ? t('wiki.translatingProgress', {
                              done: translate.progressTotal - translate.progressRemaining,
                              total: translate.progressTotal,
                            })
                          : t('wiki.translating')}
                      </span>
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
                  {pageRegisters.length > 1 && !showOriginal && translate.anyTranslated && (
                    <>
                      <span className="wiki-meta-sep">·</span>
                      <span className="wiki-page-registers">
                        {t('wiki.mixedRegisters', { registers: pageRegisters.join(', ') })}
                      </span>
                    </>
                  )}
                </div>

                {(currentPage.tags ?? []).length > 0 && (
                  <div className="wiki-page-tags">
                    {(currentPage.tags ?? []).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="wiki-tag-chip"
                        onClick={() => setActiveTag(tag)}
                        title={`Filter by ${tag}`}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}

                {/* Table of contents — auto-generated from headings */}
                {(() => {
                  const headings = extractHeadings(currentPage.content);
                  if (headings.length < 2) return null;
                  const minLevel = Math.min(...headings.map((h) => h.level));
                  return (
                    <nav className="wiki-toc">
                      <strong className="wiki-toc-title">{t('wiki.tableOfContents')}</strong>
                      <ul>
                        {headings.map((h, i) => (
                          <li key={i} style={{ marginLeft: `${(h.level - minLevel) * 0.8}rem` }}>
                            <a href={`#${h.id}`} className="wiki-toc-link">{h.text}</a>
                          </li>
                        ))}
                      </ul>
                    </nav>
                  );
                })()}

                {currentPage.content.trim() ? (
                  !showOriginal && translate.anyTranslated ? (
                    // Chunk-by-chunk render with per-chunk indicators.
                    // Each chunk gets its own rendered markdown block
                    // followed by the register/idiom metadata row.
                    <div className="wiki-content-body chunked" onClick={handleContentClick}>
                      {translate.chunks.map((c, i) => {
                        if (c.kind === 'blank') return null;
                        const body = c.translated ?? c.original;
                        return (
                          <div key={i} className={`wiki-chunk wiki-chunk-${c.kind}`}>
                            <div className="wiki-chunk-body">
                              {renderWithEmbeds(body, {
                                variant: 'wiki',
                                onNavigateMessage: onNavigateMessageEmbed,
                                onNavigateEvent: onNavigateEventEmbed,
                                onNavigateFile: onNavigateFileEmbed,
                              })}
                            </div>
                            <ChunkIndicators chunk={c} t={t} />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="wiki-content-body" onClick={handleContentClick}>
                      {renderWithEmbeds(currentPage.content, {
                        variant: 'wiki',
                        onNavigateMessage: onNavigateMessageEmbed,
                        onNavigateEvent: onNavigateEventEmbed,
                      })}
                    </div>
                  )
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

                <label className="auth-label">
                  {t('wiki.tagsLabel')}
                  <div className="wiki-tag-input-row">
                    {draftTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="wiki-tag-chip removable"
                        onClick={() => removeTag(tag)}
                        title="Remove"
                      >
                        {tag} ✕
                      </button>
                    ))}
                    <input
                      className="auth-input wiki-tag-input"
                      type="text"
                      value={draftTagInput}
                      onChange={(e) => setDraftTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          commitTagFromInput();
                        } else if (e.key === 'Backspace' && !draftTagInput && draftTags.length) {
                          setDraftTags(draftTags.slice(0, -1));
                        }
                      }}
                      onBlur={commitTagFromInput}
                      placeholder={t('wiki.tagInputPlaceholder')}
                    />
                  </div>
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
                  >
                    {renderWithEmbeds(draftContent, {
                      variant: 'wiki',
                      onNavigateMessage: onNavigateMessageEmbed,
                      onNavigateEvent: onNavigateEventEmbed,
                    })}
                  </div>
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
  );
}

// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useT } from '../i18n/I18nProvider';
import * as api from '../api';
import type { FileView, ActorProfile } from '@babelr/shared';
import { useFileTranslation } from '../hooks/useFileTranslation';
import { useTranslationSettings } from '../hooks/useTranslationSettings';
import { useChat } from '../hooks/useChat';
import { useTranslation } from '../hooks/useTranslation';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fileIcon(contentType?: string): string {
  if (!contentType) return '\u{1F4CE}';
  if (contentType.startsWith('image/')) return '\u{1F5BC}\uFE0F';
  if (contentType.includes('zip') || contentType.includes('tar') || contentType.includes('gzip'))
    return '\u{1F4E6}';
  if (contentType.includes('pdf') || contentType.includes('document') || contentType.includes('text'))
    return '\u{1F4C4}';
  return '\u{1F4CE}';
}

interface FilesPanelProps {
  serverId: string;
  serverName?: string;
  callerRole?: string;
  actor: ActorProfile;
  /** If set, auto-open the detail view for this file on mount. */
  initialFileId?: string | null;
  onClose: () => void;
}

export default function FilesPanel({
  serverId,
  actor,
  callerRole,
  initialFileId,
  onClose,
}: FilesPanelProps) {
  const t = useT();
  const [files, setFiles] = useState<FileView[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');

  // Translation: file descriptions
  const { settings: translationSettings } = useTranslationSettings();
  const filesList = useMemo(() => (selected ? [selected] : []), [selected]);
  const { translations: fileTranslations } =
    useFileTranslation(filesList, [], translationSettings);
  const fileTrans = selected ? fileTranslations.get(selected.id) : undefined;

  // Comment thread via the message pipeline (same pattern as event chat)
  const {
    messages: chatMessages,
    loading: chatLoading,
    hasMore: chatHasMore,
    connected: chatConnected,
    sendMessage: chatSend,
    loadMore: chatLoadMore,
    typingUsers: chatTyping,
    notifyTyping: chatNotifyTyping,
  } = useChat(actor, selected?.chatId ?? null, false);
  const { translations: chatTranslations, isTranslating: chatIsTranslating } =
    useTranslation(chatMessages, translationSettings);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-open a file when navigating from an embed click.
  useEffect(() => {
    if (!initialFileId) return;
    let cancelled = false;
    api
      .getFile(serverId, initialFileId)
      .then((file) => {
        if (!cancelled) {
          setSelected(file);
          if (file.folderPath) setCurrentFolder(file.folderPath);
        }
      })
      .catch(() => { /* file not found — stay on list */ });
    return () => { cancelled = true; };
  }, [initialFileId, serverId]);

  const loadFolder = useCallback(
    async (folder: string | null) => {
      setLoading(true);
      setCurrentFolder(folder);
      setSelected(null);
      const [filesRes, foldersRes] = await Promise.all([
        api.listFiles(serverId, { folder: folder ?? '' }),
        api.listFolders(serverId, folder),
      ]);
      setFiles(filesRes.files);
      setFolders(foldersRes.folders);
      setLoading(false);
    },
    [serverId],
  );

  useEffect(() => {
    void loadFolder(null);
  }, [loadFolder]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const uploaded = await api.uploadFile(serverId, file, {
        folderPath: currentFolder ?? undefined,
      });
      setFiles((prev) => [uploaded, ...prev]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const path = currentFolder ? `${currentFolder}/${name}` : name;
    setFolders((prev) => (prev.includes(path) ? prev : [...prev, path].sort()));
    setNewFolderName('');
    setShowNewFolder(false);
  };

  const navigateUp = () => {
    if (!currentFolder) return;
    const parts = currentFolder.split('/');
    parts.pop();
    void loadFolder(parts.length > 0 ? parts.join('/') : null);
  };

  const openDetail = (file: FileView) => {
    setSelected(file);
    setEditingDescription(false);
    setDescriptionDraft('');
  };

  const handleDelete = async (file: FileView) => {
    if (!window.confirm(t('files.deleteConfirm'))) return;
    await api.deleteFile(serverId, file.id);
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    setSelected(null);
  };

  const canDelete = (file: FileView) =>
    file.uploader.id === actor.id ||
    ['moderator', 'admin', 'owner'].includes(callerRole ?? '');

  const copyReference = async (slug: string) => {
    const text = `[[file:${slug}]]`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nothing more we can do */ }
      document.body.removeChild(ta);
    }
  };

  // Breadcrumb segments
  const breadcrumbs = currentFolder ? currentFolder.split('/') : [];

  return (
    <div className="inline-main-view">
      <div className="inline-main-header">
        <h2>{t('files.title')}</h2>
        <button className="settings-close" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="files-split">
        {/* Left: file browser */}
        <div className={`files-browser ${selected ? 'has-detail' : ''}`}>
          {/* Breadcrumb navigation */}
          <div className="file-breadcrumb">
            <button
              className={`file-breadcrumb-segment ${currentFolder === null ? 'active' : ''}`}
              onClick={() => void loadFolder(null)}
            >
              /
            </button>
            {breadcrumbs.map((seg, i) => {
              const path = breadcrumbs.slice(0, i + 1).join('/');
              return (
                <span key={path}>
                  <span className="file-breadcrumb-sep">/</span>
                  <button
                    className={`file-breadcrumb-segment ${path === currentFolder ? 'active' : ''}`}
                    onClick={() => void loadFolder(path)}
                  >
                    {seg}
                  </button>
                </span>
              );
            })}
          </div>

          {/* Toolbar */}
          <div className="files-toolbar">
            <button
              className="friends-btn accept"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? t('files.uploading') : t('files.upload')}
            </button>
            <button className="friends-btn" onClick={() => setShowNewFolder(true)}>
              {t('files.newFolder')}
            </button>
            <input ref={fileInputRef} type="file" hidden onChange={handleUpload} />
          </div>

          {showNewFolder && (
            <div className="file-new-folder">
              <input
                type="text"
                className="auth-input"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={t('files.folderPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') setShowNewFolder(false);
                }}
                autoFocus
              />
              <button className="friends-btn accept" onClick={handleCreateFolder}>
                {t('common.add')}
              </button>
              <button className="friends-btn" onClick={() => setShowNewFolder(false)}>
                {t('common.cancel')}
              </button>
            </div>
          )}

          {loading ? (
            <div className="sidebar-empty">{t('common.loading')}</div>
          ) : (
            <div className="files-list">
              {/* Up navigation */}
              {currentFolder !== null && (
                <div className="file-row" onClick={navigateUp}>
                  <span className="file-icon">{'\u{1F4C1}'}</span>
                  <div className="file-info">
                    <span className="file-name">..</span>
                  </div>
                </div>
              )}

              {/* Subfolders */}
              {folders.map((folder) => {
                const folderName = folder.includes('/')
                  ? folder.slice(folder.lastIndexOf('/') + 1)
                  : folder;
                return (
                  <div
                    key={`folder-${folder}`}
                    className="file-row"
                    onClick={() => void loadFolder(folder)}
                  >
                    <span className="file-icon">{'\u{1F4C1}'}</span>
                    <div className="file-info">
                      <span className="file-name">{folderName}</span>
                    </div>
                  </div>
                );
              })}

              {/* Files */}
              {files.map((file) => (
                <div key={file.id} className="file-row" onClick={() => openDetail(file)}>
                  <span className="file-icon">{fileIcon(file.contentType)}</span>
                  <div className="file-info">
                    <span className="file-name">{file.filename}</span>
                    <span className="file-meta">
                      {formatSize(file.sizeBytes)} &middot;{' '}
                      {new Date(file.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}

              {folders.length === 0 && files.length === 0 && (
                <div className="sidebar-empty">{t('files.noFiles')}</div>
              )}
            </div>
          )}
        </div>

        {/* Right: detail panel — description left, comments right */}
        {selected && (
          <div className="file-detail">
            <div className="file-detail-header">
              <h3>
                {fileIcon(selected.contentType)} {selected.title || selected.filename}
              </h3>
              <button className="settings-close" onClick={() => setSelected(null)}>
                &times;
              </button>
            </div>
            <div className="file-detail-split">
              {/* Left: metadata + description */}
              <div className="file-detail-info">
                <p className="file-meta">
                  {t('files.uploadedBy', {
                    user: selected.uploader.displayName ?? selected.uploader.preferredUsername,
                  })}{' '}
                  &middot; {formatSize(selected.sizeBytes)}
                  &middot; {new Date(selected.createdAt).toLocaleDateString()}
                </p>
                {selected.tags && selected.tags.length > 0 && (
                  <div className="file-tags">
                    {selected.tags.map((tag) => (
                      <span key={tag} className="wiki-tag-chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="file-detail-actions">
                  <a href={selected.storageUrl} download className="friends-btn accept">
                    {t('files.download')}
                  </a>
                  {selected.slug && (
                    <button className="friends-btn" onClick={() => copyReference(selected.slug!)}>
                      {t('files.copyReference')}
                    </button>
                  )}
                  {canDelete(selected) && (
                    <button className="friends-btn decline" onClick={() => handleDelete(selected)}>
                      {t('common.delete')}
                    </button>
                  )}
                </div>
                {selected.contentType.startsWith('image/') && (
                  <img
                    src={selected.storageUrl}
                    alt={selected.filename}
                    className="file-detail-preview"
                  />
                )}
                <div className="settings-divider" />
                <h4>{t('files.fileDescription')}</h4>
                {editingDescription ? (
                  <div className="file-description-edit">
                    <textarea
                      className="auth-input wiki-content-textarea"
                      value={descriptionDraft}
                      onChange={(e) => setDescriptionDraft(e.target.value)}
                      rows={6}
                      placeholder={t('files.descriptionPlaceholder')}
                      autoFocus
                    />
                    <div className="file-detail-actions">
                      <button
                        className="friends-btn accept"
                        onClick={async () => {
                          const updated = await api.updateFile(serverId, selected.id, {
                            description: descriptionDraft.trim() || null,
                          });
                          setSelected(updated);
                          setFiles((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
                          setEditingDescription(false);
                        }}
                      >
                        {t('common.save')}
                      </button>
                      <button className="friends-btn" onClick={() => setEditingDescription(false)}>
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="file-description-body file-description-clickable"
                    onClick={() => {
                      setDescriptionDraft(selected.description ?? '');
                      setEditingDescription(true);
                    }}
                    title={t('files.editDescription')}
                  >
                    {fileTrans?.description ?? selected.description ?? t('files.descriptionPlaceholder')}
                  </div>
                )}
              </div>

              {/* Right: comments */}
              <div className="file-detail-comments">
                <h4>{t('files.comments')}</h4>
                <div className="file-chat-embed">
                  <MessageList
                    messages={chatMessages}
                    loading={chatLoading}
                    hasMore={chatHasMore}
                    onLoadMore={chatLoadMore}
                    translations={chatTranslations}
                    isTranslating={chatIsTranslating}
                    actor={actor}
                  />
                  <TypingIndicator users={chatTyping} />
                  <MessageInput
                    onSend={chatSend}
                    disabled={!chatConnected}
                    onTyping={chatNotifyTyping}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

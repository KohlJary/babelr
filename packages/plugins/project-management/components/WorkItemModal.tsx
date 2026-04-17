// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import { T } from '../../../client/src/components/T.js';
import { TaskComments } from './TaskComments.js';
import type { ActorProfile } from '@babelr/shared';
import type { WorkItemView } from '../manifest.js';

const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
const ITEM_TYPES = ['task', 'bug', 'story', 'epic'] as const;

export interface WorkItemDetailModalProps {
  item: WorkItemView;
  actor: ActorProfile;
  routeBase: string;
  onClose: () => void;
  onMutated: () => void;
}

export function WorkItemDetailModal({
  item,
  actor,
  routeBase,
  onClose,
  onMutated,
}: WorkItemDetailModalProps) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [priority, setPriority] = useState(item.priority);
  const [itemType, setItemType] = useState(item.itemType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    title.trim() !== item.title ||
    description !== (item.description ?? '') ||
    priority !== item.priority ||
    itemType !== item.itemType;

  const handleSave = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${routeBase}/work-items/${encodeURIComponent(item.slug)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim() || null,
            priority,
            itemType,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error ?? 'Save failed');
        setSaving(false);
        return;
      }
      onMutated();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this card?')) return;
    setSaving(true);
    try {
      const res = await fetch(
        `${routeBase}/work-items/${encodeURIComponent(item.slug)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (res.ok) onMutated();
      else setSaving(false);
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="pm-modal-overlay" onClick={onClose}>
      <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
        <header className="pm-modal-header">
          <h3><T>Work item</T></h3>
          <button type="button" className="pm-modal-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="pm-modal-body">
          <label className="pm-form-field">
            <span><T>Title</T></span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="pm-form-field">
            <span><T>Description</T></span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
            />
          </label>
          <div className="pm-modal-row">
            <label className="pm-form-field">
              <span><T>Priority</T></span>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="pm-form-field">
              <span><T>Type</T></span>
              <select value={itemType} onChange={(e) => setItemType(e.target.value)}>
                {ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && <div className="pm-form-error">{error}</div>}
          {item.chatId && (
            <div className="pm-modal-comments">
              <div className="pm-modal-comments-label">
                <T>Comments</T>
              </div>
              <TaskComments actor={actor} chatId={item.chatId} />
            </div>
          )}
        </div>
        <footer className="pm-modal-footer">
          <button
            type="button"
            className="pm-modal-delete"
            onClick={() => void handleDelete()}
            disabled={saving}
          >
            <T>Delete</T>
          </button>
          <div className="pm-modal-footer-right">
            <button type="button" onClick={onClose} disabled={saving}>
              <T>Cancel</T>
            </button>
            <button
              type="button"
              className="pm-form-submit"
              disabled={!dirty || !title.trim() || saving}
              onClick={() => void handleSave()}
            >
              {saving ? <T>Saving…</T> : <T>Save</T>}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

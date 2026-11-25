// SPDX-License-Identifier: MIT
import { useState, useRef, useMemo, useEffect, useLayoutEffect } from 'react';
import { useT } from '../i18n/I18nProvider';
import {
  MentionAutocomplete,
  matchMentionCandidates,
  mentionQueryAt,
  type MentionCandidate,
} from './MentionAutocomplete';

interface Attachment {
  url: string;
  filename: string;
  contentType: string;
}

interface MessageInputProps {
  onSend: (content: string, attachments?: Attachment[]) => Promise<void>;
  disabled: boolean;
  onTyping?: () => void;
  /** People who can be @mentioned here (server members, DM participants). */
  mentionCandidates?: MentionCandidate[];
}

export function MessageInput({ onSend, disabled, onTyping, mentionCandidates }: MessageInputProps) {
  const t = useT();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // @mention autocomplete: the @token at the caret, the highlighted
  // suggestion, and the token start the user dismissed with Escape.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const suggestions = useMemo(
    () =>
      mention && mentionCandidates && mention.start !== dismissedAt
        ? matchMentionCandidates(mentionCandidates, mention.query)
        : [],
    [mention, mentionCandidates, dismissedAt],
  );

  const trackMention = (text: string, caret: number) => {
    const next = mentionQueryAt(text, caret);
    if (next?.start !== mention?.start || next?.query !== mention?.query) {
      setMention(next);
      setMentionIndex(0);
    }
    if (!next) setDismissedAt(null);
  };

  const insertMention = (username: string) => {
    if (!mention) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    const inserted = `@${username}${after.startsWith(' ') ? '' : ' '}`;
    const next = before + inserted + after;
    setValue(next);
    setMention(null);
    const pos = before.length + inserted.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  // The box grows with the draft, up to about six lines (CSS max-height),
  // then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    el.style.height = `${Math.min(full, max)}px`;
    el.style.overflowY = full > max ? 'auto' : 'hidden';
  }, [value]);

  // Something hands you words to send (a daemon's room: "this is wrong" puts
  // "You have this wrong about me: …" here). It lands in the draft, never sent.
  // The caret goes to the end, ready to add to it, but the box shows the
  // draft from its start, so she reads what it says.
  useEffect(() => {
    const onCompose = (e: Event) => {
      const text = (e as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text !== 'string') return;
      setValue(text);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(text.length, text.length);
        el.scrollTop = 0;
      });
    };
    window.addEventListener('babelr:compose', onCompose);
    return () => window.removeEventListener('babelr:compose', onCompose);
  }, []);

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      setAttachments((prev) => [...prev, data]);
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach(uploadFile);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      Array.from(files).forEach(uploadFile);
    }
  };

  // A pasted image (a screenshot, a copied picture) uploads like a dropped file,
  // so it never has to be saved first. Text pastes are left alone.
  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    files.forEach((f, i) => {
      const ext = f.type.split('/')[1]?.split('+')[0] || 'bin';
      const generic = !f.name || /^image\.\w+$/.test(f.name);
      const name = generic
        ? `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}`
        : f.name;
      uploadFile(generic ? new File([f], name, { type: f.type }) : f);
    });
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const content = value.trim();
    if ((!content && attachments.length === 0) || sending) return;

    setSending(true);
    setSendError(null);
    try {
      await onSend(content || '', attachments.length > 0 ? attachments : undefined);
      setValue('');
      setAttachments([]);
      inputRef.current?.focus();
    } catch (err) {
      // Nothing was sent (e.g. a DM that couldn't be encrypted): keep
      // the draft and say why.
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setMentionIndex((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(
          suggestions[Math.min(mentionIndex, suggestions.length - 1)].preferredUsername,
        );
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(mention?.start ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isImage = (ct: string) => ct.startsWith('image/');

  return (
    <div
      className={`message-input-wrapper ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {attachments.length > 0 && (
        <div className="attachment-preview">
          {attachments.map((att, i) => (
            <div key={i} className="attachment-item">
              {isImage(att.contentType) ? (
                <img src={att.url} alt={att.filename} className="attachment-thumb" />
              ) : (
                <span className="attachment-file">{att.filename}</span>
              )}
              <button className="attachment-remove" onClick={() => removeAttachment(i)}>
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <MentionAutocomplete
        users={suggestions}
        activeIndex={mentionIndex}
        onSelect={insertMention}
        onHover={setMentionIndex}
        listId="composer-mention-list"
      />
      {sendError && (
        <div className="message-input-error" role="alert">
          {sendError}
        </div>
      )}
      <div className="message-input">
        <button
          className="upload-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          title="Upload file"
        >
          {uploading ? '...' : '+'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            trackMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            if (e.target.value.length > 0) onTyping?.();
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            trackMention(el.value, el.selectionStart ?? el.value.length);
          }}
          onBlur={() => setMention(null)}
          onKeyDown={handleKeyDown}
          aria-autocomplete="list"
          aria-controls={suggestions.length > 0 ? 'composer-mention-list' : undefined}
          aria-activedescendant={
            suggestions.length > 0 ? `composer-mention-list-${mentionIndex}` : undefined
          }
          onPaste={handlePaste}
          placeholder={dragOver ? t('messages.dropFiles') : t('messages.placeholder')}
          disabled={disabled || sending}
          rows={1}
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || sending || (!value.trim() && attachments.length === 0)}
        >
          Send
        </button>
      </div>
    </div>
  );
}

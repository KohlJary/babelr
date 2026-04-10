// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useRef } from 'react';
import { useT } from '../i18n/I18nProvider';

interface Attachment {
  url: string;
  filename: string;
  contentType: string;
}

interface MessageInputProps {
  onSend: (content: string, attachments?: Attachment[]) => Promise<void>;
  disabled: boolean;
  onTyping?: () => void;
}

export function MessageInput({ onSend, disabled, onTyping }: MessageInputProps) {
  const t = useT();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const content = value.trim();
    if ((!content && attachments.length === 0) || sending) return;

    setSending(true);
    try {
      await onSend(content || '', attachments.length > 0 ? attachments : undefined);
      setValue('');
      setAttachments([]);
      inputRef.current?.focus();
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isImage = (ct: string) => ct.startsWith('image/');

  return (
    <div
      className={`message-input-wrapper ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
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
              <button className="attachment-remove" onClick={() => removeAttachment(i)}>&times;</button>
            </div>
          ))}
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
            if (e.target.value.length > 0) onTyping?.();
          }}
          onKeyDown={handleKeyDown}
          placeholder={dragOver ? t('messages.dropFiles') : t('messages.placeholder')}
          disabled={disabled || sending}
          rows={1}
        />
        <button onClick={handleSubmit} disabled={disabled || sending || (!value.trim() && attachments.length === 0)}>
          Send
        </button>
      </div>
    </div>
  );
}

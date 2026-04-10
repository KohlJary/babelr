// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface GlossaryEditorProps {
  channelId: string;
  onClose: () => void;
}

export function GlossaryEditor({ channelId, onClose }: GlossaryEditorProps) {
  const t = useT();
  const [glossary, setGlossary] = useState<Record<string, string>>({});
  const [newTerm, setNewTerm] = useState('');
  const [newMeaning, setNewMeaning] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getGlossary(channelId)
      .then(setGlossary)
      .finally(() => setLoading(false));
  }, [channelId]);

  const addEntry = () => {
    if (!newTerm.trim() || !newMeaning.trim()) return;
    const updated = { ...glossary, [newTerm.trim()]: newMeaning.trim() };
    setGlossary(updated);
    setNewTerm('');
    setNewMeaning('');
  };

  const removeEntry = (term: string) => {
    const updated = { ...glossary };
    delete updated[term];
    setGlossary(updated);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateGlossary(channelId, glossary);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('glossary.title')}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <p className="settings-hint">{t('glossary.hint')}</p>

        {loading ? (
          <div className="sidebar-empty">{t('common.loading')}</div>
        ) : (
          <>
            <div className="glossary-entries">
              {Object.entries(glossary).map(([term, meaning]) => (
                <div key={term} className="glossary-entry">
                  <span className="glossary-term">{term}</span>
                  <span className="glossary-arrow">&rarr;</span>
                  <span className="glossary-meaning">{meaning}</span>
                  <button className="glossary-remove" onClick={() => removeEntry(term)}>
                    &times;
                  </button>
                </div>
              ))}
              {Object.keys(glossary).length === 0 && (
                <div className="sidebar-empty">{t('glossary.empty')}</div>
              )}
            </div>

            <div className="glossary-add">
              <input
                className="modal-input"
                placeholder={t('glossary.term')}
                value={newTerm}
                onChange={(e) => setNewTerm(e.target.value)}
              />
              <input
                className="modal-input"
                placeholder={t('glossary.translation')}
                value={newMeaning}
                onChange={(e) => setNewMeaning(e.target.value)}
              />
              <button className="discover-join-btn" onClick={addEntry}>
                {t('common.add')}
              </button>
            </div>

            <button className="auth-submit" onClick={save} disabled={saving}>
              {saving ? '...' : t('glossary.save')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

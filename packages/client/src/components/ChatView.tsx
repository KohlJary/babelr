// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import type { ActorProfile } from '@babelr/shared';
import { useChat } from '../hooks/useChat';
import { useTranslationSettings } from '../hooks/useTranslationSettings';
import { useTranslation } from '../hooks/useTranslation';
import { ChannelHeader } from './ChannelHeader';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SettingsPanel } from './SettingsPanel';

interface ChatViewProps {
  actor: ActorProfile;
  onLogout: () => void;
}

export function ChatView({ actor, onLogout }: ChatViewProps) {
  const { channel, messages, loading, hasMore, connected, sendMessage, loadMore } = useChat(actor);
  const { settings, updateSettings } = useTranslationSettings();
  const { translations, isTranslating } = useTranslation(messages, settings);
  const [showSettings, setShowSettings] = useState(false);

  // Initialize preferredLanguage from actor profile on first use
  useEffect(() => {
    if (!localStorage.getItem('babelr:translation-settings')) {
      updateSettings({ preferredLanguage: actor.preferredLanguage });
    }
  }, [actor.preferredLanguage, updateSettings]);

  return (
    <div className="chat-view">
      <ChannelHeader
        channel={channel}
        actor={actor}
        connected={connected}
        onLogout={onLogout}
        onOpenSettings={() => setShowSettings(true)}
      />
      <MessageList
        messages={messages}
        loading={loading}
        hasMore={hasMore}
        onLoadMore={loadMore}
        translations={translations}
        isTranslating={isTranslating}
      />
      <MessageInput onSend={sendMessage} disabled={!channel || !connected} />
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onUpdate={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

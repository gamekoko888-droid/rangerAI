/**
 * TagManager — Inline panel for adding/removing tags on a chat.
 */

import { useState, useRef, useEffect } from 'react';
import { useChatListStore } from '../../stores/useChatListStore';
import { parseTags } from '../../lib/types';
import { X, Plus, Tag } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface TagManagerProps {
  chatId: string;
  onClose: () => void;
}

export function TagManager({ chatId, onClose }: TagManagerProps) {
  const { t } = useI18n();
  const { chats, updateChatTags, loadTags } = useChatListStore();
  const chat = chats.find((c: { id: string }) => c.id === chatId);
  const currentTags = parseTags(chat?.tags || null);
  const [newTag, setNewTag] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleAddTag = async (tagOverride?: string) => {
    const tag = (tagOverride ?? newTag).trim();
    if (!tag || currentTags.includes(tag)) {
      setNewTag('');
      return;
    }
    const updatedTags = [...currentTags, tag];
    await updateChatTags(chatId, updatedTags);
    setNewTag('');
    loadTags(); // Refresh global tags list
  };

  const handleRemoveTag = async (tag: string) => {
    const updatedTags = currentTags.filter(t => t !== tag);
    await updateChatTags(chatId, updatedTags);
    loadTags();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  };

  // Suggested tags from global tags that aren't already on this chat
  const allTags = useChatListStore((s) => s.allTags);
  const suggestedTags = allTags.filter((t: string) => !currentTags.includes(t));

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/80 px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
            <Tag size={12} />
            <span>{t('tag.title')}</span>
          </div>
          <button
            onClick={onClose}
            className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Current tags */}
        <div className="flex flex-wrap gap-1.5 mb-2">
          {currentTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full
                         bg-blue-600/15 border border-blue-500/30 text-blue-300"
            >
              {tag}
              <button
                onClick={() => handleRemoveTag(tag)}
                className="hover:text-red-300 transition-colors"
              >
                <X size={10} />
              </button>
            </span>
          ))}
          {currentTags.length === 0 && (
            <span className="text-xs text-zinc-500">{t('tag.noTags')}</span>
          )}
        </div>

        {/* Add tag input */}
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1.5 bg-zinc-800 rounded-lg border border-zinc-700 px-2.5 py-1.5
                          focus-within:border-zinc-500 transition-colors">
            <Plus size={12} className="text-zinc-500 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('tag.inputPlaceholder')}
              className="flex-1 bg-transparent text-xs text-zinc-200 placeholder-zinc-500 outline-none"
            />
          </div>
          <button
            onClick={() => handleAddTag()}
            disabled={!newTag.trim()}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 
                       disabled:text-zinc-500 text-white transition-colors disabled:cursor-not-allowed"
          >
            {t('tag.add')}
          </button>
        </div>

        {/* Suggested tags */}
        {suggestedTags.length > 0 && (
          <div className="mt-2">
            <p className="text-[10px] text-zinc-500 mb-1">{t('tag.existingTags')}</p>
            <div className="flex flex-wrap gap-1">
              {suggestedTags.slice(0, 10).map((tag) => (
                <button
                  key={tag}
                  onClick={() => handleAddTag(tag)}
                  className="text-[10px] px-1.5 py-0 rounded-full border border-zinc-700 text-zinc-400
                             hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                >
                  + {tag}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

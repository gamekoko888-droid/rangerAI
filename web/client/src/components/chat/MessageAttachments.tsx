/**
 * MessageAttachments — Renders attachments inside a message bubble.
 * Images: thumbnail with lightbox on click.
 * Files: icon + name + download link.
 */

import { useState } from 'react';
import { FileText, Download, X, ExternalLink } from 'lucide-react';
import type { Attachment } from '../../lib/types';
import { getFileUrl } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']);

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface MessageAttachmentsProps {
  attachments: Attachment[];
  isUser?: boolean;
}

export function MessageAttachments({ attachments, isUser }: MessageAttachmentsProps) {
  const { t } = useI18n();
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  if (!attachments || attachments.length === 0) return null;

  const images = attachments.filter(a => a.type === 'image' || IMAGE_TYPES.has(a.mimeType));
  const files = attachments.filter(a => a.type === 'file' && !IMAGE_TYPES.has(a.mimeType));

  return (
    <>
      {/* Image grid */}
      {images.length > 0 && (
        <div className={`flex flex-wrap gap-1.5 ${images.length === 1 ? '' : 'max-w-[300px]'} mb-1.5`}>
          {images.map((img, i) => {
            const url = getFileUrl(img.url);
            return (
              <button
                key={i}
                onClick={() => setLightboxUrl(url)}
                className={`rounded-lg overflow-hidden border transition-opacity hover:opacity-90 active:opacity-75
                           ${isUser ? 'border-blue-500/30' : 'border-zinc-600/50'}`}
              >
                <img
                  src={url}
                  alt={img.name}
                  className={`object-cover ${
                    images.length === 1
                      ? 'max-w-[280px] sm:max-w-[360px] max-h-[240px] sm:max-h-[300px]'
                      : 'w-[100px] h-[100px] sm:w-[120px] sm:h-[120px]'
                  }`}
                  loading="lazy"
                />
              </button>
            );
          })}
        </div>
      )}

      {/* File list */}
      {files.length > 0 && (
        <div className="flex flex-col gap-1 mb-1.5">
          {files.map((file, i) => {
            const url = getFileUrl(file.url);
            return (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                download={file.name}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors text-xs
                           ${isUser
                             ? 'bg-blue-500/20 hover:bg-blue-500/30 text-blue-100'
                             : 'bg-zinc-700/50 hover:bg-zinc-700/80 text-zinc-300'}`}
              >
                <FileText size={14} className="shrink-0" />
                <span className="truncate flex-1 min-w-0">{file.name}</span>
                {file.size > 0 && (
                  <span className="text-[10px] opacity-60 shrink-0">{formatSize(file.size)}</span>
                )}
                <Download size={12} className="shrink-0 opacity-60" />
              </a>
            );
          })}
        </div>
      )}

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-zinc-800/80 text-zinc-300 hover:text-white hover:bg-zinc-700 transition-colors z-10"
          >
            <X size={20} />
          </button>
          <a
            href={lightboxUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute top-4 right-16 p-2 rounded-full bg-zinc-800/80 text-zinc-300 hover:text-white hover:bg-zinc-700 transition-colors z-10"
            onClick={(e) => e.stopPropagation()}
            title={t('attachment.openInNewTab')}
          >
            <ExternalLink size={20} />
          </a>
          <img
            src={lightboxUrl}
            alt="Preview"
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

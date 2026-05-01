/**
 * AttachmentPreview — Shows pending attachments above the input area.
 * Displays image thumbnails and file icons with upload progress.
 */

import { X, FileText, File, Loader2, Image as ImageIcon } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

export interface PendingAttachment {
  id: string;
  file: File;
  preview?: string;   // data URL for image preview
  progress: number;    // 0-100, -1 = error
  uploaded?: {
    url: string;
    path: string;
    name: string;
    size: number;
  };
  error?: string;
}

interface AttachmentPreviewProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  const { t } = useI18n();
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1 px-1">
      {attachments.map((att) => {
        const isImage = IMAGE_TYPES.has(att.file.type);
        const isUploading = att.progress >= 0 && att.progress < 100 && !att.uploaded;
        const isError = att.progress === -1;
        const isDone = !!att.uploaded;

        return (
          <div
            key={att.id}
            className={`relative shrink-0 group rounded-lg overflow-hidden border transition-colors
                       ${isError ? 'border-red-500/50 bg-red-500/10' : 'border-zinc-700 bg-zinc-800/80'}`}
          >
            {/* Remove button */}
            <button
              onClick={() => onRemove(att.id)}
              className="absolute top-0.5 right-0.5 z-10 p-0.5 rounded-full bg-zinc-900/80 text-zinc-400 
                         hover:text-white hover:bg-zinc-900 transition-colors opacity-0 group-hover:opacity-100
                         sm:opacity-0 sm:group-hover:opacity-100"
              style={{ opacity: 1 }} // Always visible on mobile
            >
              <X size={12} />
            </button>

            {isImage && att.preview ? (
              /* Image thumbnail */
              <div className="w-16 h-16 sm:w-20 sm:h-20 relative">
                <img
                  src={att.preview}
                  alt={att.file.name}
                  className={`w-full h-full object-cover ${isUploading ? 'opacity-50' : ''}`}
                />
                {isUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <Loader2 size={16} className="animate-spin text-white" />
                  </div>
                )}
                {/* Progress bar */}
                {isUploading && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-700">
                    <div
                      className="h-full bg-blue-500 transition-all duration-200"
                      style={{ width: `${att.progress}%` }}
                    />
                  </div>
                )}
              </div>
            ) : (
              /* File icon */
              <div className="w-16 h-16 sm:w-20 sm:h-20 flex flex-col items-center justify-center gap-1 px-1">
                {isUploading ? (
                  <Loader2 size={20} className="animate-spin text-zinc-400" />
                ) : isError ? (
                  <FileText size={20} className="text-red-400" />
                ) : isImage ? (
                  <ImageIcon size={20} className="text-blue-400" />
                ) : (
                  <File size={20} className="text-zinc-400" />
                )}
                <span className="text-[9px] text-zinc-500 truncate max-w-full leading-tight text-center">
                  {att.file.name.length > 12
                    ? att.file.name.slice(0, 8) + '...' + att.file.name.slice(-3)
                    : att.file.name}
                </span>
                <span className="text-[8px] text-zinc-600">{formatSize(att.file.size)}</span>
              </div>
            )}

            {/* Done indicator */}
            {isDone && (
              <div className="absolute bottom-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-green-500 flex items-center justify-center">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <path d="M1.5 4L3.2 5.7L6.5 2.3" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            )}

            {/* Error indicator */}
            {isError && (
              <div className="absolute bottom-0 left-0 right-0 bg-red-500/80 text-[8px] text-white text-center py-0.5">
                {t('attachment.failed')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

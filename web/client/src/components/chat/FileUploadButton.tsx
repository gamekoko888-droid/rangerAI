/**
 * FileUploadButton — Trigger for file/image upload.
 * Supports: click to select, drag-and-drop, clipboard paste.
 * Shows upload progress and file previews.
 */

import { useRef, useCallback } from 'react';
import { Paperclip, ImagePlus } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

interface FileUploadButtonProps {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
  /** 'all' = any file, 'image' = images only */
  mode?: 'all' | 'image';
}

export function FileUploadButton({ onFilesSelected, disabled, mode = 'all' }: FileUploadButtonProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      const valid = files.filter(f => {
        if (f.size > MAX_FILE_SIZE) {
          alert(`${f.name}: ${t('upload.fileTooLarge')}`);
          return false;
        }
        return true;
      });
      if (valid.length > 0) onFilesSelected(valid);
    }
    // Reset input so same file can be selected again
    if (inputRef.current) inputRef.current.value = '';
  }, [onFilesSelected]);

  const accept = mode === 'image'
    ? IMAGE_TYPES.join(',')
    : undefined; // all files

  const Icon = mode === 'image' ? ImagePlus : Paperclip;
  const title = mode === 'image' ? t('upload.uploadImage') : t('upload.uploadFile');

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        onChange={handleChange}
        className="sr-only"        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="p-1.5 sm:p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50
                   active:bg-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        title={title}
      >
        <Icon size={18} />
      </button>
    </>
  );
}

/**
 * Check if a file is an image based on MIME type.
 */
export function isImageFile(file: File | { mimeType?: string; name?: string }): boolean {
  if ('type' in file && file.type) {
    return IMAGE_TYPES.includes(file.type);
  }
  const mime = (file as { mimeType?: string }).mimeType || '';
  if (IMAGE_TYPES.includes(mime)) return true;
  // Fallback: check extension
  const name = (file as { name?: string }).name || '';
  return /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(name);
}

import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useI18n } from '@/lib/i18n';
import { WifiOff, Wifi } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A fixed banner that appears when the user goes offline,
 * and briefly shows a "back online" message when connectivity resumes.
 */
export function NetworkStatusBar() {
  const { isOnline, wasOffline } = useNetworkStatus();
  const { t } = useI18n();

  if (isOnline && !wasOffline) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-all duration-300',
        isOnline
          ? 'bg-emerald-600 text-white'
          : 'bg-destructive text-destructive-foreground'
      )}
    >
      {isOnline ? (
        <>
          <Wifi size={16} />
          <span>{t('network.backOnline')}</span>
        </>
      ) : (
        <>
          <WifiOff size={16} />
          <span>{t('network.offline')}</span>
        </>
      )}
    </div>
  );
}

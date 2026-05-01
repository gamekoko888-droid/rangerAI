import { cn } from "@/lib/utils";
import { logger } from "../lib/logger";
import { useI18n } from "@/lib/i18n";
import { AlertTriangle, RotateCcw, Home, ChevronDown, ChevronUp } from "lucide-react";
import { Component, ReactNode, useState } from "react";
import { reportError } from "@/lib/api";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** If true, shows a compact inline error instead of full-page */
  inline?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  retryCount: number;
}

const MAX_AUTO_RETRY = 2;

/** Functional fallback that can use hooks */
function ErrorFallback({ error, errorInfo, retryCount, onRetry, inline }: {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  retryCount: number;
  onRetry: () => void;
  inline?: boolean;
}) {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);

  if (inline) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
        <AlertTriangle size={20} className="text-destructive flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground">
            {error?.message || t('error.unexpectedError')}
          </p>
        </div>
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 cursor-pointer flex-shrink-0"
        >
          <RotateCcw size={12} />
          {t('error.reloadPage')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-8 bg-background">
      <div className="flex flex-col items-center w-full max-w-2xl p-8">
        <AlertTriangle
          size={48}
          className="text-destructive mb-6 flex-shrink-0"
        />

        <h2 className="text-xl mb-2 text-foreground">{t('error.unexpectedError')}</h2>
        
        <p className="text-sm text-muted-foreground mb-6 text-center">
          {error?.message || t('error.unexpectedError')}
          {retryCount > 0 && (
            <span className="block mt-1 text-xs text-amber-500">
              {t('error.autoRetryAttempted').replace('{count}', String(retryCount))}
            </span>
          )}
        </p>

        {/* Error details (collapsible) */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4 cursor-pointer"
        >
          {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {showDetails ? t('error.hideDetails') : t('error.showDetails')}
        </button>

        {showDetails && (
          <div className="p-4 w-full rounded bg-muted overflow-auto mb-6 max-h-60">
            <pre className="text-xs text-muted-foreground whitespace-break-spaces">
              {error?.stack}
              {errorInfo?.componentStack && (
                <>
                  {'\n\n' + t('error.componentStack') + ':'}
                  {errorInfo.componentStack}
                </>
              )}
            </pre>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={onRetry}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg",
              "bg-primary text-primary-foreground",
              "hover:opacity-90 cursor-pointer"
            )}
          >
            <RotateCcw size={16} />
            {t('error.reloadPage')}
          </button>

          <button
            onClick={() => {
              window.location.href = '/';
            }}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg",
              "bg-secondary text-secondary-foreground",
              "hover:opacity-90 cursor-pointer"
            )}
          >
            <Home size={16} />
            {t('error.backToHome')}
          </button>
        </div>
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });
    logger.error('[ErrorBoundary] Caught error:', error, errorInfo);

    // Report error to backend (fire-and-forget)
    reportError({
      message: error.message,
      stack: error.stack,
      component: errorInfo.componentStack?.slice(0, 500) || undefined,
      extra: { retryCount: this.state.retryCount },
    });

    // Auto-retry for transient errors (network, JSON parse, etc.)
    if (this.state.retryCount < MAX_AUTO_RETRY) {
      const isTransient = 
        error.message.includes('JSON') ||
        error.message.includes('fetch') ||
        error.message.includes('network') ||
        error.message.includes('502') ||
        error.message.includes('503') ||
        error.message.includes('timeout') ||
        error.message.includes('ChunkLoadError') ||
        error.message.includes('Loading chunk');

      if (isTransient) {
        logger.debug(`[ErrorBoundary] Transient error detected, auto-retrying (${this.state.retryCount + 1}/${MAX_AUTO_RETRY})...`);
        setTimeout(() => {
          this.setState(prev => ({
            hasError: false,
            error: null,
            errorInfo: null,
            retryCount: prev.retryCount + 1,
          }));
        }, 1000 * (this.state.retryCount + 1)); // Exponential backoff: 1s, 2s
      }
    }
  }

  handleRetry = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <ErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          retryCount={this.state.retryCount}
          onRetry={this.handleRetry}
          inline={this.props.inline}
        />
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

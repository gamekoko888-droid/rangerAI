/**
 * Web Vitals — Performance monitoring for RangerAI
 * 
 * Collects Core Web Vitals (LCP, FID, CLS, FCP, TTFB, INP) and reports
 * them to the console in development and to the analytics endpoint in production.
 */

import { onCLS, onFCP, onLCP, onTTFB, onINP, type Metric } from 'web-vitals';
import { logger } from "./logger";

// Thresholds based on Google's recommended values
const THRESHOLDS: Record<string, { good: number; poor: number }> = {
  CLS: { good: 0.1, poor: 0.25 },
  FCP: { good: 1800, poor: 3000 },
  LCP: { good: 2500, poor: 4000 },
  TTFB: { good: 800, poor: 1800 },
  INP: { good: 200, poor: 500 },
};

function getRating(name: string, value: number): 'good' | 'needs-improvement' | 'poor' {
  const threshold = THRESHOLDS[name];
  if (!threshold) return 'good';
  if (value <= threshold.good) return 'good';
  if (value >= threshold.poor) return 'poor';
  return 'needs-improvement';
}

const vitalsBuffer: Metric[] = [];

function handleMetric(metric: Metric) {
  vitalsBuffer.push(metric);

  // Console logging in development
  if (import.meta.env.DEV) {
    const rating = getRating(metric.name, metric.value);
    const color = rating === 'good' ? '#10b981' : rating === 'poor' ? '#ef4444' : '#f59e0b';
    logger.debug(
      `%c[Web Vitals] ${metric.name}: ${metric.value.toFixed(metric.name === 'CLS' ? 3 : 0)}${metric.name === 'CLS' ? '' : 'ms'} (${rating})`,
      `color: ${color}; font-weight: bold;`
    );
  }

  // In production, send to analytics endpoint (if configured)
  if (import.meta.env.PROD) {
    const analyticsEndpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT;
    if (analyticsEndpoint) {
      // Use sendBeacon for reliability (doesn't block page unload)
      const body = JSON.stringify({
        name: metric.name,
        value: metric.value,
        rating: metric.rating,
        delta: metric.delta,
        id: metric.id,
        navigationType: metric.navigationType,
        url: window.location.href,
        timestamp: Date.now(),
      });

      if (navigator.sendBeacon) {
        navigator.sendBeacon(`${analyticsEndpoint}/api/web-vitals`, body);
      }
    }
  }
}

/**
 * Initialize Web Vitals collection.
 * Call once at app startup.
 */
export function initWebVitals() {
  onCLS(handleMetric);
  onFCP(handleMetric);
  onLCP(handleMetric);
  onTTFB(handleMetric);
  onINP(handleMetric);
}

/**
 * Get all collected vitals (useful for debugging).
 */
export function getCollectedVitals(): Metric[] {
  return [...vitalsBuffer];
}

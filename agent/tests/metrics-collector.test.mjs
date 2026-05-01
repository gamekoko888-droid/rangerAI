import { describe, it, beforeAll } from "vitest";;
import { expect } from "vitest";;

describe('Metrics Collector', () => {
  let metrics;

  beforeAll(async () => {
    const mod = await import('../lib/metrics-collector.mjs');
    metrics = mod.default;
  });

  it('should export default metrics instance', () => {
    expect(metrics, 'metrics should be defined').toBeTruthy();
  });

  it('should have recordHttpRequest method', () => {
    expect(typeof metrics.recordHttpRequest).toBe('function');
  });

  it('should have recordError method', () => {
    expect(typeof metrics.recordError).toBe('function');
  });

  it('should have getSnapshot method', () => {
    expect(typeof metrics.getSnapshot).toBe('function');
  });

  it('should have toPrometheus method', () => {
    expect(typeof metrics.toPrometheus).toBe('function');
  });

  it('should record HTTP request without error', () => {
    expect(() => {
      metrics.recordHttpRequest('GET', '/api/health', 200, 5);
    }).not.toThrow();
  });

  it('should return valid snapshot', () => {
    const snapshot = metrics.getSnapshot();
    expect(snapshot, 'snapshot should be defined').toBeTruthy();
    expect(typeof snapshot).toBe('object');
  });

  it('should return Prometheus format string', () => {
    const prom = metrics.toPrometheus();
    expect(typeof prom).toBe('string');
    expect(prom.length > 0, 'Prometheus output should not be empty').toBeTruthy();
  });
});

import { describe, it, beforeAll } from "vitest";;
import { expect } from "vitest";;

describe('Logger Module', () => {
  let logger;

  beforeAll(async () => {
    // Dynamic import to handle ESM
    const mod = await import('../lib/logger.mjs');
    logger = mod.logger;
  });

  it('should export logger object', () => {
    expect(logger, 'logger should be defined').toBeTruthy();
  });

  it('should have standard log methods', () => {
    expect(typeof logger.info).toBe('function', 'info should be a function');
    expect(typeof logger.warn).toBe('function', 'warn should be a function');
    expect(typeof logger.error).toBe('function', 'error should be a function');
    expect(typeof logger.debug).toBe('function', 'debug should be a function');
  });

  it('should not throw on log calls', () => {
    expect(() => logger.info('test info')).not.toThrow();
    expect(() => logger.warn('test warn')).not.toThrow();
    expect(() => logger.error('test error')).not.toThrow();
    expect(() => logger.debug('test debug')).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_BASE_URL, loadConfig } from '../../src/config.js';
import { createLogger, redact } from '../../src/log.js';

describe('loadConfig', () => {
  it('fills in defaults', () => {
    const config = loadConfig({ CURSOR_API_KEY: 'crsr_abc' });
    expect(config).toEqual({
      apiKey: 'crsr_abc',
      baseUrl: DEFAULT_BASE_URL,
      logLevel: 'warn',
      rateLimitPerMin: 20,
    });
  });

  it('strips trailing slashes from the base URL', () => {
    expect(loadConfig({ CURSOR_API_KEY: 'k', CURSOR_API_BASE: 'http://x.test//' }).baseUrl).toBe('http://x.test');
  });

  it('fails with an actionable message when the key is missing', () => {
    const error = (() => {
      try {
        loadConfig({});
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('CURSOR_API_KEY');
    expect((error as ConfigError).message).toContain('print-config');
  });

  it('rejects a bad log level or rate limit', () => {
    expect(() => loadConfig({ CURSOR_API_KEY: 'k', CURSOR_MCP_LOG_LEVEL: 'loud' })).toThrow(ConfigError);
    expect(() => loadConfig({ CURSOR_API_KEY: 'k', CURSOR_MCP_RATE_LIMIT_PER_MIN: '0' })).toThrow(ConfigError);
  });
});

describe('logging', () => {
  it('redacts API keys and Authorization headers', () => {
    expect(redact('key crsr_supersecretvalue here')).toBe('key [redacted] here');
    expect(redact('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]');
  });

  it('writes to the injected sink, not stdout, and respects the level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (line) => void lines.push(line) });
    logger.debug('invisible');
    logger.warn('visible', { token: 'crsr_leak' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('visible');
    expect(lines[0]).not.toContain('crsr_leak');
  });
});

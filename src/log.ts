/**
 * stderr-only logging.
 *
 * STDOUT IS THE MCP TRANSPORT: writing anything to stdout from server, tool or
 * client code corrupts the JSON-RPC framing. Everything here goes to stderr.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export const LOG_LEVELS = Object.keys(LEVEL_ORDER) as LogLevel[];

export function isLogLevel(value: string): value is LogLevel {
  return Object.prototype.hasOwnProperty.call(LEVEL_ORDER, value);
}

export interface Logger {
  error(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

const SECRET_PATTERNS: RegExp[] = [
  /crsr_[A-Za-z0-9._-]+/g,
  /(Bearer\s+)[A-Za-z0-9._-]+/gi,
  /(Basic\s+)[A-Za-z0-9+/=]+/gi,
];

/** Scrub anything that looks like an API key or auth header out of log output. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      // args[1] is the first capture group when the pattern has one, else the offset.
      const prefix = args[1];
      return typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]';
    });
  }
  return out;
}

function serialize(meta: unknown): string {
  if (meta === undefined) return '';
  if (typeof meta === 'string') return ` ${redact(meta)}`;
  if (meta instanceof Error) return ` ${redact(`${meta.name}: ${meta.message}`)}`;
  try {
    return ` ${redact(JSON.stringify(meta))}`;
  } catch {
    return ' [unserializable meta]';
  }
}

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Injected for tests; defaults to stderr. */
  write?: (line: string) => void;
  name?: string;
}

export function createLogger({
  level,
  write = (line) => void process.stderr.write(line),
  name = 'cursor-cloud-agents-mcp',
}: CreateLoggerOptions): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (lineLevel: LogLevel, message: string, meta?: unknown): void => {
    if (LEVEL_ORDER[lineLevel] > threshold) return;
    write(`[${name}] ${lineLevel} ${redact(message)}${serialize(meta)}\n`);
  };

  return {
    error: (message, meta) => emit('error', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    info: (message, meta) => emit('info', message, meta),
    debug: (message, meta) => emit('debug', message, meta),
  };
}

/** Logger that drops everything — the default when no logger is injected. */
export const silentLogger: Logger = createLogger({ level: 'silent', write: () => {} });

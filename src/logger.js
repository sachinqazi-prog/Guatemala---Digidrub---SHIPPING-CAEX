/**
 * Minimal logger with levels and timestamps.
 * Avoiding heavy deps (winston/pino) — Render's log viewer handles console output fine.
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel() {
  return LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;
}

function write(level, message, extra) {
  if (LEVELS[level] < currentLevel()) return;
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (extra !== undefined) {
    console.log(base, typeof extra === 'string' ? extra : JSON.stringify(extra));
  } else {
    console.log(base);
  }
}

export const log = {
  debug: (msg, extra) => write('debug', msg, extra),
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
};

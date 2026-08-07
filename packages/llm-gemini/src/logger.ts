export type Logger = {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
};

const formatArgs = (args: unknown[]): string =>
  args.length > 0 ? ` ${args.map((value) => String(value)).join(" ")}` : "";

const writeLogLine = (level: string, message: string, args: unknown[]): string =>
  `${new Date().toISOString()} ${level.toUpperCase()} ${message}${formatArgs(args)}\n`;

const consoleLogger: Logger = {
  debug(message, ...args) {
    console.debug(writeLogLine("debug", message, args).trimEnd());
  },
  info(message, ...args) {
    console.info(writeLogLine("info", message, args).trimEnd());
  },
  warn(message, ...args) {
    console.warn(writeLogLine("warn", message, args).trimEnd());
  },
  error(message, ...args) {
    console.error(writeLogLine("error", message, args).trimEnd());
  },
};

/** Minimal logger for Gemini package diagnostics (no framework dependency). */
export const getLogger = (): Logger => consoleLogger;

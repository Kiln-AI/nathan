export type LogFields = Record<string, unknown>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string) => void;

/** One JSON line per call; Workers Logs indexes the fields. */
export function createConsoleLogger(base: LogFields = {}, sink: LogSink = console.log): Logger {
  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    sink(toJsonLine({ ...base, ...fields, level, msg }));
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => createConsoleLogger({ ...base, ...fields }, sink),
  };
}

/** Never throws: callers such as `reportError` promise not to. */
function toJsonLine(entry: LogFields): string {
  try {
    return JSON.stringify(entry, serializeErrors);
  } catch (error) {
    return JSON.stringify({ level: entry.level, msg: entry.msg, logError: String(error) });
  }
}

function serializeErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

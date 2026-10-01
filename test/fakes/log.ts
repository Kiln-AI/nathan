import type { LogFields, Logger, LogLevel } from "../../src/core/log";

export interface LogEntry {
  level: LogLevel;
  msg: string;
  fields: LogFields;
}

/** Captures log calls (and keeps test output quiet). */
export class MemoryLogger implements Logger {
  constructor(
    readonly entries: LogEntry[] = [],
    private readonly base: LogFields = {},
  ) {}

  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }

  child(fields: LogFields): Logger {
    return new MemoryLogger(this.entries, { ...this.base, ...fields });
  }

  at(level: LogLevel): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  private write(level: LogLevel, msg: string, fields: LogFields = {}): void {
    this.entries.push({ level, msg, fields: { ...this.base, ...fields } });
  }
}

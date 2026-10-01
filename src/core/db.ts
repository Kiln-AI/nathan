export type SqlParam = string | number | null;

/** Thin typed helpers over D1. Feature repositories write plain SQL on top of these. */
export interface Db {
  first<T>(sql: string, ...params: SqlParam[]): Promise<T | null>;
  all<T>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  run(sql: string, ...params: SqlParam[]): Promise<{ changes: number }>;
  statement(sql: string, ...params: SqlParam[]): D1PreparedStatement;
  /** Runs the statements in one transaction. */
  batch(statements: D1PreparedStatement[]): Promise<{ changes: number }[]>;
}

export function createDb(d1: D1Database): Db {
  const statement = (sql: string, ...params: SqlParam[]) => d1.prepare(sql).bind(...params);
  return {
    statement,
    first: <T>(sql: string, ...params: SqlParam[]) => statement(sql, ...params).first<T>(),
    all: async <T>(sql: string, ...params: SqlParam[]) => (await statement(sql, ...params).all<T>()).results,
    run: async (sql, ...params) => ({ changes: (await statement(sql, ...params).run()).meta.changes }),
    batch: async (statements) => (await d1.batch(statements)).map((r) => ({ changes: r.meta.changes })),
  };
}

/**
 * Minimal D1Database stand-in backed by node:sqlite, so database code runs
 * against real SQLite with the real migrations. Covers the subset of the D1
 * API this app uses: prepare/bind/first/all/run, batch, exec.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

class Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    const normalized = params.map((value) => (value === undefined ? null : value)) as SQLInputValue[];
    return new Statement(this.sqlite, this.sql, normalized);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T>() {
    const results = this.sqlite.prepare(this.sql).all(...this.params) as T[];
    return { results, success: true, meta: {} };
  }

  async run() {
    const info = this.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  /** Executes inside an open transaction (batch); returns the D1-shaped result. */
  execute() {
    const statement = this.sqlite.prepare(this.sql);
    if (statement.columns().length > 0) {
      return { results: statement.all(...this.params), success: true, meta: {} };
    }
    const info = statement.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

class TestD1 {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.sqlite, sql);
  }

  /** Runs all statements in one transaction, like D1. */
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/**
 * Creates a fresh in-memory database with every migration applied.
 * @returns the D1-compatible binding plus the raw sqlite handle for assertions
 */
export function createTestDb(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  return { db: new TestD1(sqlite) as unknown as D1Database, sqlite };
}

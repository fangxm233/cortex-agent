/** A D1 binding backed by node:sqlite with the real migrations applied (D1 is SQLite). */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, Row } from '../../src/env.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));

function plain(row: unknown): Row {
  return { ...(row as Row) };
}

type Bound = SQLInputValue[] | [Record<string, SQLInputValue>];

/** node:sqlite only binds `?NNN` parameters by name ("1", "2", ...); D1 binds them by position. */
function bindable(sql: string, values: SQLInputValue[]): Bound {
  if (!/\?\d/.test(sql)) return values;
  return [Object.fromEntries(values.map((value, i) => [String(i + 1), value]))];
}

function statement(raw: DatabaseSync, sql: string, values: SQLInputValue[]): D1PreparedStatement {
  const args = () => bindable(sql, values) as SQLInputValue[];
  return {
    bind: (...next: unknown[]) => statement(raw, sql, next as SQLInputValue[]),
    run: async () => {
      raw.prepare(sql).run(...args());
      return { results: [], success: true };
    },
    all: async <T>() => ({ results: raw.prepare(sql).all(...args()).map(plain) as T[], success: true }),
    first: async <T>() => {
      const row = raw.prepare(sql).get(...args());
      return (row ? plain(row) : null) as T | null;
    },
  };
}

export interface TestDatabase {
  db: D1Database;
  raw: DatabaseSync;
  rows(sql: string, ...values: SQLInputValue[]): Row[];
}

export function sqliteD1(): TestDatabase {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`${MIGRATIONS}${file}`, 'utf8'));
  }
  const db: D1Database = {
    prepare: sql => statement(raw, sql, []),
    async batch<T>(statements: D1PreparedStatement[]) {
      raw.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) results.push(await item.all<T>());
        raw.exec('COMMIT');
        return results;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, raw, rows: (sql, ...values) => raw.prepare(sql).all(...values).map(plain) };
}

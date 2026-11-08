import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// The real schema behind a D1-shaped adapter. A batch may carry reads as well
// as writes, as on D1, and each statement comes back as { results, meta }; the
// batch is one transaction, so changes() inside it sees the statement before.
export function schemaDb() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return sql;
}

const returnsRows = (query) => /^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query);

export function d1(sql) {
  return {
    prepare(query) {
      const bound = (args = []) => {
        const runSync = () => {
          const statement = sql.prepare(query);
          if (returnsRows(query)) {
            const results = statement.all(...args);
            return {
              results,
              meta: { changes: /^\s*(SELECT|WITH)\b/i.test(query) ? 0 : results.length },
            };
          }
          const result = statement.run(...args);
          return {
            results: [],
            meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
          };
        };
        return {
          query,
          bind: (...values) => bound(values),
          first: async () => sql.prepare(query).get(...args) || null,
          all: async () => ({ results: sql.prepare(query).all(...args) }),
          run: async () => runSync(),
          runSync,
        };
      };
      return bound();
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.runSync());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

// Every D1 call in order, a batch as one entry since it is one round trip.
// Each call answers a timer tick later, as a network call would, and is
// stamped with how many calls had answered when it started: calls started
// before any neighbour answered share a `wave`, which is one round trip of
// waiting however many run side by side.
export function countingDb(sql) {
  const db = d1(sql);
  const ops = [];
  let answered = 0;
  const slow = (entry, work) => {
    ops.push({ ...entry, wave: answered });
    return new Promise((resolve) => setTimeout(resolve, 0)).then(work)
      .finally(() => { answered += 1; });
  };
  const wrap = (statement) => ({
    ...statement,
    bind: (...args) => wrap(statement.bind(...args)),
    first: () => slow({ kind: 'first', sql: statement.query }, () => statement.first()),
    all: () => slow({ kind: 'all', sql: statement.query }, () => statement.all()),
    run: () => slow({ kind: 'run', sql: statement.query }, () => statement.run()),
  });
  return {
    ops,
    DB: {
      prepare: (query) => wrap(db.prepare(query)),
      batch: (statements) => slow(
        { kind: 'batch', sql: statements.map((statement) => statement.query) },
        () => db.batch(statements)
      ),
    },
  };
}

// Round trips in a stretch of the log: one per wave.
export const waves = (ops) => new Set(ops.map((op) => op.wave)).size;

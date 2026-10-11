import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

function normalize(row) {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).map(([name, value]) => {
    if (value instanceof Date) return [name, value.toISOString()];
    if (['content', 'data', 'metadata'].includes(name) && typeof value === 'object' && value !== null) return [name, JSON.stringify(value)];
    if (name === 'archived' && typeof value === 'boolean') return [name, Number(value)];
    if (name === 'count') return [name, Number(value)];
    return [name, value];
  }));
}

export function createSqliteStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema.sqlite.sql', import.meta.url), 'utf8'));
  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  const exclusive = async callback => {
    if (context.getStore()) return callback();
    const operation = queue.then(() => context.run(true, callback));
    queue = operation.catch(() => {});
    return operation;
  };
  return {
    raw: db,
    dialect: 'sqlite',
    run: (sql, ...params) => exclusive(() => db.prepare(sql).run(...params)),
    get: (sql, ...params) => exclusive(() => db.prepare(sql).get(...params)),
    all: (sql, ...params) => exclusive(() => db.prepare(sql).all(...params)),
    transaction: callback => exclusive(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    ready: async () => {},
    close: async () => { await queue; db.close(); }
  };
}

export function createPostgresStore({ connectionString, ca, pool: suppliedPool } = {}) {
  if (!suppliedPool) {
    if (!connectionString) throw new Error('DATABASE_URL is required when DATABASE_PROVIDER=supabase');
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection string');
    for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    connectionString = url.toString();
  }
  const pool = suppliedPool || new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, ssl: { rejectUnauthorized: true, ca }, application_name: 'tus3dev' });
  pool.on?.('error', () => console.error('PostgreSQL pool connection error'));
  const context = new AsyncLocalStorage();
  const withClient = async callback => {
    const active = context.getStore();
    if (active) return callback(active);
    const client = await pool.connect();
    try {
      await client.query('SET search_path TO tus3dev, pg_catalog');
      await client.query("SET statement_timeout TO '15s'");
      await client.query("SET lock_timeout TO '10s'");
      return await callback(client);
    } finally { client.release(); }
  };
  const execute = (sql, params) => withClient(client => {
    let index = 0;
    return client.query(sql.replace(/\?/g, () => `$${++index}`), params);
  });
  return {
    raw: pool,
    dialect: 'postgres',
    run: async (sql, ...params) => execute(sql, params),
    get: async (sql, ...params) => normalize((await execute(sql, params)).rows[0]),
    all: async (sql, ...params) => (await execute(sql, params)).rows.map(normalize),
    transaction: callback => withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(83932026)');
        const result = await context.run(client, callback);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }),
    ready: () => withClient(async client => {
      const result = await client.query("SELECT to_regclass('tus3dev.document_revisions') AS table_name");
      if (!result.rows[0].table_name) throw new Error('Run database/schema.postgres.sql in Supabase SQL Editor first');
      await client.query('SELECT id FROM users LIMIT 1');
    }),
    close: () => pool.end()
  };
}
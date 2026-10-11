import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('PostgreSQL schema is executable, repeatable, private, and immutable after approval', async () => {
  const db = new PGlite();
  try {
    const sql = readFileSync(new URL('../database/schema.postgres.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    const tables = await db.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='tus3dev'");
    assert.equal(tables.rows[0].count, 12);
    await db.exec("INSERT INTO tus3dev.users(id,name,email,password_hash,salt) VALUES('test-owner','Test owner','test@example.com','test-hash','test-salt');");
    await db.exec("INSERT INTO tus3dev.documents(id,user_id,number,type,content) VALUES('test-doc','test-owner','TUS-TEST-1','invoice','{}');");
    await db.exec("UPDATE tus3dev.documents SET status='Approved',approved_at=now() WHERE id='test-doc';");
    await assert.rejects(db.exec("UPDATE tus3dev.documents SET content='{\"changed\":true}' WHERE id='test-doc';"), /immutable/);
    await db.exec("UPDATE tus3dev.documents SET archived=true WHERE id='test-doc';");
    await db.exec("INSERT INTO tus3dev.document_events(document_id,type) VALUES('test-doc','approved');");
    await assert.rejects(db.exec("DELETE FROM tus3dev.document_events WHERE document_id='test-doc';"), /immutable/);
    await db.exec('CREATE ROLE test_guest; GRANT USAGE ON SCHEMA tus3dev TO test_guest; GRANT SELECT ON tus3dev.users TO test_guest; SET ROLE test_guest;');
    const hidden = await db.query('SELECT count(*)::int AS count FROM tus3dev.users');
    assert.equal(hidden.rows[0].count, 0);
    await db.exec('RESET ROLE;');
    const rls = await db.query("SELECT count(*)::int AS count FROM pg_class JOIN pg_namespace ON pg_class.relnamespace=pg_namespace.oid WHERE pg_namespace.nspname='tus3dev' AND pg_class.relkind='r' AND pg_class.relrowsecurity=true");
    assert.equal(rls.rows[0].count, 12);
  } finally { await db.close(); }
});
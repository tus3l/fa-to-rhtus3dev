PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT REFERENCES clients(id),
  number TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id,number,revision)
);

CREATE TABLE IF NOT EXISTS document_items (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents(id),
  image TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_links (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  token_hash TEXT NOT NULL UNIQUE,
  encrypted_token TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_events (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS documents_owner_status ON documents(user_id,status,updated_at);
CREATE INDEX IF NOT EXISTS clients_owner ON clients(user_id,name);
CREATE INDEX IF NOT EXISTS links_document ON document_links(document_id,revoked_at);
CREATE INDEX IF NOT EXISTS events_document ON document_events(document_id,created_at);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS items_document ON document_items(document_id,position);
CREATE INDEX IF NOT EXISTS payments_document ON payments(document_id,position);

CREATE TRIGGER IF NOT EXISTS approved_document_immutable BEFORE UPDATE ON documents
  WHEN OLD.status='Approved' AND (NEW.content<>OLD.content OR NEW.status<>OLD.status OR NEW.number<>OLD.number OR NEW.revision<>OLD.revision OR NEW.type<>OLD.type OR NEW.user_id<>OLD.user_id)
  BEGIN SELECT RAISE(ABORT,'Approved document content is immutable'); END;

CREATE TRIGGER IF NOT EXISTS signature_immutable BEFORE UPDATE ON signatures
  BEGIN SELECT RAISE(ABORT,'Signature is immutable'); END;

CREATE TRIGGER IF NOT EXISTS revision_immutable BEFORE UPDATE ON document_revisions
  BEGIN SELECT RAISE(ABORT,'Approved snapshot is immutable'); END;

CREATE TRIGGER IF NOT EXISTS event_immutable BEFORE UPDATE ON document_events
  BEGIN SELECT RAISE(ABORT,'Audit event is immutable'); END;
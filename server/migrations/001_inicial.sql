-- Usuarios del CRM (empleados)
CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'vendedor', 'recepcion')),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- WhatsApp (misma estructura que la app actual, para poder migrar datos)
CREATE TABLE whatsapp_accounts (
  id            text PRIMARY KEY,               -- phone_number_id de Meta
  label         text NOT NULL,
  display_phone text NOT NULL,
  verified_name text NOT NULL,
  last_event_at timestamptz,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_conversations (
  id              serial PRIMARY KEY,
  account_id      text NOT NULL REFERENCES whatsapp_accounts(id),
  contact_phone   text NOT NULL,
  contact_name    text NOT NULL,
  preview         text NOT NULL DEFAULT '',
  last_message_at timestamptz NOT NULL,
  last_inbound_at timestamptz,
  -- CRM
  assigned_to     integer REFERENCES users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'cerrado')),
  UNIQUE (account_id, contact_phone)
);
CREATE INDEX whatsapp_conversation_time_idx ON whatsapp_conversations(last_message_at);
CREATE INDEX whatsapp_conversation_assigned_idx ON whatsapp_conversations(assigned_to);

CREATE TABLE whatsapp_messages (
  id                serial PRIMARY KEY,
  conversation_id   integer NOT NULL REFERENCES whatsapp_conversations(id),
  direction         text NOT NULL,
  type              text NOT NULL DEFAULT 'text',
  text              text NOT NULL,
  status            text NOT NULL,
  provider_id       text UNIQUE,
  client_request_id text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  sender_username   text,
  sender_name       text,
  error             text,
  UNIQUE (conversation_id, client_request_id)
);
CREATE INDEX whatsapp_message_conversation_idx ON whatsapp_messages(conversation_id, id);

CREATE TABLE whatsapp_reads (
  conversation_id    integer NOT NULL REFERENCES whatsapp_conversations(id),
  username           text NOT NULL,
  through_message_id integer NOT NULL,
  PRIMARY KEY (conversation_id, username)
);

CREATE TABLE whatsapp_receipts (
  provider_id text PRIMARY KEY,
  account_id  text NOT NULL REFERENCES whatsapp_accounts(id),
  status      text NOT NULL,
  error       text,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE whatsapp_integration_state (
  key         text PRIMARY KEY,
  verified_at timestamptz NOT NULL
);

-- CRM: etiquetas y notas internas por conversación
CREATE TABLE tags (
  id    serial PRIMARY KEY,
  name  text NOT NULL UNIQUE,
  color text NOT NULL DEFAULT '#64748b'
);
INSERT INTO tags(name, color) VALUES
  ('Prospecto', '#2563eb'), ('Socio', '#16a34a'), ('Deudor', '#dc2626'),
  ('No renovó', '#d97706'), ('Consulta', '#7c3aed');

CREATE TABLE conversation_tags (
  conversation_id integer NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  tag_id          integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);

CREATE TABLE conversation_notes (
  id              serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  user_id         integer REFERENCES users(id) ON DELETE SET NULL,
  author_name     text NOT NULL,
  text            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_notes_idx ON conversation_notes(conversation_id, id);

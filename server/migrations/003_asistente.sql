-- Asistente: conversaciones de cada empleado con Claude (también sirve de registro de consultas)
CREATE TABLE assistant_chats (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_chats_user_idx ON assistant_chats(user_id, updated_at DESC);

CREATE TABLE assistant_messages (
  id         serial PRIMARY KEY,
  chat_id    integer NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  text       text NOT NULL,
  tools      jsonb NOT NULL DEFAULT '[]',  -- consultas hechas a la app (nombre + parámetros)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_chat_idx ON assistant_messages(chat_id, id);
CREATE INDEX assistant_messages_time_idx ON assistant_messages(created_at);

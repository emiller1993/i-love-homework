BEGIN;
ALTER TABLE conversations ADD COLUMN stopped boolean NOT NULL DEFAULT false;
CREATE TABLE conversation_history (
  conversation_id text NOT NULL REFERENCES conversations(id),
  temporal_run_id text NOT NULL,
  parts jsonb NOT NULL DEFAULT '{}',
  snapshot text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, temporal_run_id)
);
CREATE TABLE input_events (
  conversation_id text NOT NULL REFERENCES conversations(id),
  event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, event_id)
);
COMMIT;

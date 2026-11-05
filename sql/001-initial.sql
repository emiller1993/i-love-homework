CREATE TABLE workflows (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, key)
);
CREATE TABLE workflow_versions (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows(id),
  version integer NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
CREATE TABLE sandboxes (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  workflow_version_ids jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('normal', 'accelerated')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversations (
  id text PRIMARY KEY,
  sandbox_id text NOT NULL REFERENCES sandboxes(id),
  account_id text NOT NULL,
  contact_id text NOT NULL,
  temporal_workflow_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sandbox_id, account_id, contact_id)
);
CREATE TABLE mock_calls (
  invocation_id text PRIMARY KEY,
  sandbox_id text NOT NULL REFERENCES sandboxes(id),
  task_token bytea NOT NULL,
  result jsonb,
  error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deliveries (
  action_id text PRIMARY KEY,
  sandbox_id text NOT NULL REFERENCES sandboxes(id),
  channel text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE backtests (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  input jsonb NOT NULL,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

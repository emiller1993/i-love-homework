import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  SandboxRecord,
  WorkflowDefinition,
  WorkflowVersion,
} from "./domain.js";

export async function saveWorkflowVersion(
  pool: Pool,
  definition: WorkflowDefinition,
): Promise<WorkflowVersion> {
  // TODO: allow mcp
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO workflows (id, account_id, key) VALUES ($1, 'demo-account', $2) ON CONFLICT (account_id, key) DO NOTHING",
      [randomUUID(), definition.key],
    );
    // The row lock assigns immutable versions even when two uploads arrive together.
    const workflow = await client.query<{ id: string }>(
      "SELECT id FROM workflows WHERE account_id = 'demo-account' AND key = $1 FOR UPDATE",
      [definition.key],
    );
    const workflowId = workflow.rows[0]!.id;
    const count = await client.query<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_versions WHERE workflow_id = $1",
      [workflowId],
    );
    const version = {
      id: randomUUID(),
      key: definition.key,
      version: count.rows[0]!.version,
      definition,
    };
    await client.query(
      "INSERT INTO workflow_versions (id, workflow_id, version, definition) VALUES ($1, $2, $3, $4)",
      [version.id, workflowId, version.version, definition],
    );
    await client.query("COMMIT");
    return version;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWorkflowVersions(
  pool: Pool,
): Promise<WorkflowVersion[]> {
  const result = await pool.query<WorkflowVersion>(
    `SELECT v.id, w.key, v.version, v.definition FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE w.account_id = 'demo-account' ORDER BY v.created_at, v.id`,
  );
  return result.rows;
}

export async function createSandbox(
  pool: Pool,
  workflowVersionIds: string[],
  mode: SandboxRecord["mode"],
): Promise<SandboxRecord> {
  const versions = await listWorkflowVersions(pool);
  if (
    workflowVersionIds.some(
      (id) => !versions.some((version) => version.id === id),
    )
  )
    throw new RangeError("Unknown workflow version");
  const sandbox = {
    id: randomUUID(),
    accountId: "demo-account",
    workflowVersionIds: [...new Set(workflowVersionIds)],
    mode,
  };
  await pool.query(
    "INSERT INTO sandboxes (id, account_id, workflow_version_ids, mode) VALUES ($1, $2, $3, $4)",
    [
      sandbox.id,
      sandbox.accountId,
      JSON.stringify(sandbox.workflowVersionIds),
      mode,
    ],
  );
  return sandbox;
}

export async function loadSandbox(
  pool: Pool,
  sandboxId: string,
): Promise<SandboxRecord> {
  const result = await pool.query<SandboxRecord>(
    `SELECT id, account_id AS "accountId", workflow_version_ids AS "workflowVersionIds", mode FROM sandboxes WHERE id = $1 AND account_id = 'demo-account'`,
    [sandboxId],
  );
  if (!result.rows[0]) throw new RangeError("Unknown sandbox");
  return result.rows[0];
}

export async function loadSandboxVersions(
  pool: Pool,
  sandboxId: string,
): Promise<WorkflowVersion[]> {
  const sandbox = await loadSandbox(pool, sandboxId);
  const versions = await listWorkflowVersions(pool);
  return sandbox.workflowVersionIds.map((id) =>
    versions.find((version) => version.id === id)!,
  );
}

export async function setWorkflowEnabled(
  pool: Pool,
  sandboxId: string,
  workflowVersionId: string,
  enabled: boolean,
): Promise<void> {
  const versions = await listWorkflowVersions(pool);
  if (!versions.some((version) => version.id === workflowVersionId))
    throw new RangeError("Unknown workflow version");
  const sandbox = await loadSandbox(pool, sandboxId);
  if (sandbox.workflowVersionIds.includes(workflowVersionId) === enabled)
    return;
  await pool.query(
    `UPDATE sandboxes SET workflow_version_ids = CASE WHEN $3 THEN (SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(workflow_version_ids || jsonb_build_array($2::text))) ELSE COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(workflow_version_ids) WHERE value <> to_jsonb($2::text)), '[]') END WHERE id = $1`,
    [sandbox.id, workflowVersionId, enabled],
  );
}

export async function loadConversations(
  pool: Pool,
  sandboxId: string,
): Promise<
  {
    id: string;
    contactId: string;
    temporalWorkflowId: string;
    stopped: boolean;
  }[]
> {
  const result = await pool.query<{
    id: string;
    contactId: string;
    temporalWorkflowId: string;
    stopped: boolean;
  }>(
    `SELECT id, contact_id AS "contactId", temporal_workflow_id AS "temporalWorkflowId", stopped FROM conversations WHERE sandbox_id = $1 ORDER BY created_at, id`,
    [sandboxId],
  );
  return result.rows;
}

export async function saveConversation(
  pool: Pool,
  sandbox: SandboxRecord,
  contactId: string,
): Promise<string> {
  const id = `${sandbox.id}:${sandbox.accountId}:${contactId}`;
  await pool.query(
    "INSERT INTO conversations (id, sandbox_id, account_id, contact_id, temporal_workflow_id) VALUES ($1, $2, $3, $4, $1) ON CONFLICT DO NOTHING",
    [id, sandbox.id, sandbox.accountId, contactId],
  );
  return id;
}

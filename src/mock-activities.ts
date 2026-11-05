import {
  activityInfo,
  CompleteAsyncError,
  ApplicationFailure,
} from "@temporalio/activity";
import type { Pool } from "pg";
import type { ActionRecord, JsonValue } from "./domain.js";
import { validateAgentResult, type Activities } from "./activities.js";

export function createMockActivities(pool: Pool): Activities {
  return {
    async executeAgent(input): Promise<JsonValue> {
      const result = await pool.query<{
        result: JsonValue;
        error: string | null;
        completed_at: Date | null;
      }>(
        `INSERT INTO mock_calls (invocation_id, sandbox_id, task_token) VALUES ($1, $2, $3) ON CONFLICT (invocation_id) DO UPDATE SET task_token = EXCLUDED.task_token RETURNING result, error, completed_at`,
        [
          input.invocation.id,
          input.sandboxId,
          Buffer.from(activityInfo().taskToken),
        ],
      );
      const completed = result.rows[0]!;
      if (completed.completed_at) {
        if (completed.error)
          throw ApplicationFailure.nonRetryable(completed.error);
        return validateAgentResult(input.invocation, completed.result);
      }
      // No worker slot or process-local promise is held while a user controls the result.
      throw new CompleteAsyncError();
    },
    async sendMessage(action: ActionRecord): Promise<ActionRecord> {
      if (action.channel === "comment" && !action.commentId)
        throw new RangeError("Comment replies require commentId");
      const result = await pool.query<{
        channel: ActionRecord["channel"];
        text: string;
      }>(
        `INSERT INTO deliveries (action_id, sandbox_id, channel, text) VALUES ($1, $2, $3, $4) ON CONFLICT (action_id) DO UPDATE SET action_id = deliveries.action_id RETURNING channel, text`,
        [action.id, action.sandboxId, action.channel, action.text],
      );
      return { ...action, ...result.rows[0]!, status: "completed" };
    },
  };
}

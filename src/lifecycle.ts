import type { Pool } from "pg";
import type { ConversationState } from "./domain.js";

export function createLifecycleActivities(pool: Pool): {
  saveConversation(input: {
    conversationId: string;
    temporalRunId: string;
    part: number;
    content: string;
    final: boolean;
  }): Promise<void>;
} {
  return {
    async saveConversation(input) {
      const client = await pool.connect();
      const key = [input.conversationId, input.temporalRunId];
      try {
        await client.query("BEGIN");
        if (input.final)
          await client.query(
            "SELECT id FROM conversations WHERE id = $1 FOR UPDATE",
            [input.conversationId],
          );
        await client.query(
          `INSERT INTO conversation_history (conversation_id, temporal_run_id, parts)
           VALUES ($1, $2, jsonb_build_object($3::text, $4::text))
           ON CONFLICT (conversation_id, temporal_run_id) DO UPDATE
           SET parts = conversation_history.parts || EXCLUDED.parts
           WHERE conversation_history.snapshot IS NULL`,
          [...key, input.part, input.content],
        );
        if (input.final) {
          const result = await client.query<{ snapshot: string }>(
            `UPDATE conversation_history h SET snapshot = (
               SELECT string_agg(value, '' ORDER BY key::integer) FROM jsonb_each_text(h.parts)
             ), parts = '{}' WHERE conversation_id = $1 AND temporal_run_id = $2 AND snapshot IS NULL
             RETURNING snapshot`,
            key,
          );
          if (result.rowCount) {
            const snapshot: ConversationState = JSON.parse(
              result.rows[0]!.snapshot,
            );
            // JSON text preserves accepted strings that PostgreSQL jsonb/text cannot represent directly.
            await client.query(
              `INSERT INTO input_events (conversation_id, event_id)
               SELECT $1, unnest($2::text[])
               ON CONFLICT DO NOTHING`,
              [
                input.conversationId,
                snapshot.events.map((event) => JSON.stringify(event.eventId)),
              ],
            );
            await client.query(
              "UPDATE conversations SET stopped = $2 WHERE id = $1",
              [input.conversationId, snapshot.status === "failed"],
            );
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

import Ajv from "ajv";
import type { ActionRecord, InvocationState, JsonValue } from "./domain.js";

export type AgentReply = { result: JsonValue };

export interface Activities {
  executeAgent(input: {
    sandboxId: string;
    invocation: InvocationState;
  }): Promise<JsonValue>;
  sendMessage(action: ActionRecord): Promise<ActionRecord>;
}

export function validateAgentResult(
  invocation: Pick<InvocationState, "resultSchema">,
  result: unknown,
): JsonValue {
  const ajv = new Ajv({ strict: true, allErrors: true });
  if (!ajv.validate<JsonValue>(invocation.resultSchema, result))
    throw new RangeError(`Invalid result: ${ajv.errorsText(ajv.errors)}`);
  return result;
}

import { Worker, NativeConnection } from "@temporalio/worker";
import { Pool } from "pg";
import { createHttpActivities } from "./http-activities.js";
import { createLifecycleActivities } from "./lifecycle.js";

async function main() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "temporal:7233",
  });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "workflow-automation",
      workflowsPath: require.resolve("./conversation.js"),
      activities: {
        ...createLifecycleActivities(pool),
        ...createHttpActivities(
          process.env.EXTERNAL_API_URL ?? "http://fake-api:8081",
        ),
      },
    });
    await worker.run();
  } finally {
    await pool.end();
    await connection.close();
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

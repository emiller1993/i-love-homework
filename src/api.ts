import { Pool } from "pg";
import { createRuntime } from "./runtime.js";
import { createServer } from "./server.js";

async function main() {
  const mode = process.env.EXECUTION_MODE ?? "accelerated";
  if (mode !== "normal" && mode !== "accelerated")
    throw new TypeError("EXECUTION_MODE must be normal or accelerated");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const runtime = await createRuntime({ pool, mode });
  const server = await createServer({ pool, runtime });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try {
      await server.close();
      await runtime.close();
    } finally {
      await pool.end();
    }
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void close().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  try {
    console.log(
      `Listening on ${await server.listen({ port: Number(process.env.API_PORT ?? 8080), host: "0.0.0.0" })}`,
    );
  } catch (error) {
    await close();
    throw error;
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

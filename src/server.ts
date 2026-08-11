import "dotenv/config";
import { createApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { startRetentionJob } from "./modules/logs/logs.retention.worker.js";
import { startLogsWriteWorker } from "./modules/logs/logs.write-worker.ts";
import { startLogRollupWorker } from "./modules/logs/logs.rollup-worker.ts";

const port: number = Number(process.env.PORT ?? 8080);
async function startServer(): Promise<void> {
  await runMigrations();
  startRetentionJob();
  startLogsWriteWorker();
  startLogRollupWorker();
  const app = createApp();

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

startServer().catch((error: unknown) => {
  console.error("Failed to start server\n", error);
  process.exit(1);
});

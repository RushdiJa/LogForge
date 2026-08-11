import "dotenv/config";
import { createApp } from "./app.js";
import { closeDatabasePools } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import {
  startRetentionJob,
  stopRetentionJob,
} from "./modules/logs/logs.retention.worker.js";
import {
  drainLogsQueue,
  startLogsWriteWorker,
  stopLogsWriteWorker,
} from "./modules/logs/logs.write-worker.js";

const port: number = Number(process.env.PORT ?? 8080);
async function startServer(): Promise<void> {
  await runMigrations();
  startRetentionJob();
  startLogsWriteWorker();
  const app = createApp();

  await app.listen({
    port,
    host: "0.0.0.0",
  });

  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    stopLogsWriteWorker();
    stopRetentionJob();

    await app.close();

    const drained = await drainLogsQueue();

    if (!drained) {
      console.error(
        "Timed out while draining the log write queue",
      );
    }

    await closeDatabasePools();
  }

  process.once("SIGTERM", () => {
    void shutdown().catch((error: unknown) => {
      console.error("Graceful shutdown failed", error);
      process.exitCode = 1;
    });
  });

  process.once("SIGINT", () => {
    void shutdown().catch((error: unknown) => {
      console.error("Graceful shutdown failed", error);
      process.exitCode = 1;
    });
  });
}

startServer().catch((error: unknown) => {
  console.error("Failed to start server\n", error);
  process.exit(1);
});

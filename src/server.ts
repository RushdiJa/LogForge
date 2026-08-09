import "dotenv/config";
import { createApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { startRetentionJob } from "./modules/logs/logs.retention.worker.js";

const port: number = Number(process.env.PORT ?? 8080);
async function startServer(): Promise<void> {
  await runMigrations();
  startRetentionJob();
  
  const app = createApp();

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

startServer().catch((error: unknown) => {
  console.error("Failed to start server\n", error);
  process.exit(1);
});

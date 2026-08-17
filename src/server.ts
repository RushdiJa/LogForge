import { createApp } from "./app.js";
import { retentionWorker } from "./retention.js";

const app = createApp();

try {
  await app.listen({
    port: 8080,
    host: "0.0.0.0",
  });
  retentionWorker();
} catch (error) {
  console.error(error);
  process.exit(1);
}
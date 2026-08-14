import { createApp } from "./app.js";

const app = createApp();

try {
  await app.listen({
    port: 8080,
    host: "0.0.0.0",
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
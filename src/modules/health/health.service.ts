import {checkDataBase} from "./heath.repository.js";

export async function checkHealth(): Promise<{ ready: boolean }> {
  const isDatabaseReady = await checkDataBase();
  return { ready: isDatabaseReady };
}
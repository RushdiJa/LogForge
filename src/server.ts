import { createApp } from "./app.js";
const app = createApp();

app.listen(8080, () => {
  console.log('Server listening on port 8080');
});
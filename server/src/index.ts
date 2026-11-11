import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./db.js";
import { ensureFirstAdmin } from "./lib/auth.js";
import { createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);

await migrate();
await ensureFirstAdmin();
createApp({ webDist: process.env.WEB_DIST ?? join(here, "..", "..", "web", "dist") })
  .listen(port, () => console.log(`CRM El Club escuchando en :${port}`));

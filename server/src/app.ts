import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadUser } from "./lib/auth.js";
import { UserFacingError } from "./lib/errors.js";
import authRoutes from "./routes/auth.js";
import whatsappRoutes from "./routes/whatsapp.js";
import crmRoutes from "./routes/crm.js";
import assistantRoutes from "./routes/assistant.js";

const WEBHOOKS = ["/api/whatsapp/webhook", "/api/instagram/webhook"];

export function createApp(options: { webDist?: string } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // detrás de Caddy

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });

  app.get("/api/health", (_req, res) => { res.json({ ok: true }); });

  // Guarda el cuerpo crudo del webhook para verificar la firma de Meta.
  app.use(express.json({
    limit: "2mb",
    verify: (req, _res, buffer) => {
      if (WEBHOOKS.includes((req as Request).originalUrl.split("?")[0])) (req as Request).rawBody = Buffer.from(buffer);
    },
  }));

  // Defensa CSRF: los cambios solo se aceptan desde el mismo origen (además de la cookie SameSite=Strict).
  app.use("/api", (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || WEBHOOKS.includes(`/api${req.path}`)) return next();
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}` && origin !== process.env.PUBLIC_URL?.replace(/\/$/, ""))
      throw new UserFacingError("Origen no autorizado.", 403);
    next();
  });
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.use("/api", loadUser);
  // Rol "asistente": solo el Asistente y su propia sesión; el resto del CRM queda bloqueado en el servidor.
  app.use("/api", (req, _res, next) => {
    if (req.user?.role === "asistente" && !/^\/(assistant|auth)(\/|$)/.test(req.path))
      throw new UserFacingError("Tu usuario solo tiene acceso al Asistente.", 403);
    next();
  });
  app.use("/api/assistant", assistantRoutes);
  app.use("/api", authRoutes);
  app.use("/api", whatsappRoutes);
  app.use("/api", crmRoutes);
  app.use("/api", (_req, _res) => { throw new UserFacingError("No encontrado.", 404); });

  // Frontend compilado
  const dist = options.webDist;
  if (dist && existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => { res.sendFile(join(dist, "index.html")); });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof UserFacingError) { res.status(error.status).json({ error: error.message }); return; }
    if ((error as any)?.type === "entity.parse.failed") { res.status(400).json({ error: "JSON inválido." }); return; }
    console.error(error);
    res.status(500).json({ error: "Error interno. Probá de nuevo." });
  });
  return app;
}

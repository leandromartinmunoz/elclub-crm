import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { UserFacingError } from "../lib/errors.js";
import { requireRole, requireUser } from "../lib/auth.js";
import { secureEqual, validWhatsappSignature } from "../lib/whatsapp-protocol.js";
import { verifyWhatsappPhone } from "../lib/whatsapp-provider.js";
import { verifyInstagramPage } from "../lib/instagram-provider.js";
import { igIngest, waConversationList, waIngest, waMarkRead, waMessages, waSendReply } from "../lib/whatsapp-store.js";

const router = Router();
export const positiveId = (input: unknown) => {
  const value = typeof input === "string" && /^\d+$/.test(input) ? Number(input) : typeof input === "number" ? input : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new UserFacingError("Identificador o página inválidos.");
  return value;
};
const accounts = async () => (await db().query(`SELECT id,channel,label,display_phone AS "displayPhone",
  verified_name AS "verifiedName",last_event_at AS "lastEventAt" FROM whatsapp_accounts ORDER BY created_at,id`)).rows;

// --- Webhooks de Meta (públicos, verificados por firma). Misma app de Meta para WhatsApp e Instagram. ---
for (const channel of ["whatsapp", "instagram"] as const) {
  router.get(`/${channel}/webhook`, async (req, res) => {
    const token = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (!token) { res.status(503).send("Webhook not configured"); return; }
    const verify = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
    if (req.query["hub.mode"] !== "subscribe" || typeof verify !== "string" || verify.length > 2048
      || !secureEqual(verify, token) || typeof challenge !== "string" || !/^\d{1,200}$/.test(challenge)) {
      res.status(403).send("Verification failed"); return;
    }
    await db().query(`INSERT INTO whatsapp_integration_state(key,verified_at) VALUES($1,now())
      ON CONFLICT(key) DO UPDATE SET verified_at=now()`, [channel === "whatsapp" ? "webhook" : "instagram-webhook"]);
    res.type("text/plain").send(challenge);
  });
  router.post(`/${channel}/webhook`, async (req, res) => {
    if (!process.env.WHATSAPP_APP_SECRET) { res.status(503).json({ error: "Webhook not configured" }); return; }
    if (!req.rawBody || !validWhatsappSignature(req.rawBody, req.get("X-Hub-Signature-256"), process.env.WHATSAPP_APP_SECRET)) {
      res.status(401).json({ error: "Invalid signature" }); return;
    }
    await (req.body?.object === "instagram" ? igIngest(req.body) : waIngest(req.body));
    res.json({ received: true });
  });
}

// --- Bandeja (empleados) ---
router.get("/whatsapp/status", requireUser, async (req, res) => {
  const verification = await db().query("SELECT verified_at FROM whatsapp_integration_state WHERE key='webhook'");
  const igVerification = await db().query("SELECT verified_at FROM whatsapp_integration_state WHERE key='instagram-webhook'");
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
  res.json({
    accounts: await accounts(),
    instagram: {
      tokenConfigured: !!process.env.INSTAGRAM_ACCESS_TOKEN,
      webhookVerifiedAt: igVerification.rows[0]?.verified_at ?? null,
      webhookUrl: publicUrl ? `${publicUrl}/api/instagram/webhook` : null,
    },
    canConfigure: req.user!.role === "admin",
    tokenConfigured: !!process.env.WHATSAPP_ACCESS_TOKEN,
    webhookSecure: !!process.env.WHATSAPP_APP_SECRET && !!process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    webhookVerifiedAt: verification.rows[0]?.verified_at ?? null,
    webhookUrl: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/api/whatsapp/webhook` : null,
  });
});

const AccountBody = z.object({ phoneNumberId: z.string().regex(/^\d{5,30}$/), label: z.string().max(80).optional() }).strict();
router.post("/whatsapp/accounts", requireRole("admin"), async (req, res) => {
  const body = AccountBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Ingresá el ID del número que muestra Meta, no el teléfono.");
  const verified = await verifyWhatsappPhone(body.data.phoneNumberId);
  await db().query(`INSERT INTO whatsapp_accounts(id,label,display_phone,verified_name,created_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET
      label=EXCLUDED.label,display_phone=EXCLUDED.display_phone,verified_name=EXCLUDED.verified_name`,
    [verified.id, body.data.label?.trim() || verified.verifiedName, verified.displayPhone, verified.verifiedName, req.user!.username]);
  res.json((await accounts()).find(row => row.id === verified.id));
});

const IgAccountBody = z.object({ pageId: z.string().regex(/^\d{5,30}$/), label: z.string().max(80).optional() }).strict();
router.post("/instagram/accounts", requireRole("admin"), async (req, res) => {
  const body = IgAccountBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Ingresá el ID de la página de Facebook de El Club (solo números).");
  const verified = await verifyInstagramPage(body.data.pageId);
  await db().query(`INSERT INTO whatsapp_accounts(id,channel,page_id,label,display_phone,verified_name,created_by)
    VALUES($1,'instagram',$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
      page_id=EXCLUDED.page_id,label=EXCLUDED.label,display_phone=EXCLUDED.display_phone,verified_name=EXCLUDED.verified_name`,
    [verified.igId, verified.pageId, body.data.label?.trim() || `Instagram ${verified.username ? "@" + verified.username : verified.name}`,
      verified.username ? `@${verified.username}` : verified.name, verified.name, req.user!.username]);
  res.json((await accounts()).find(row => row.id === verified.igId));
});

const ListQuery = z.object({
  search: z.string().max(100).optional(),
  unread: z.enum(["true", "false"]).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  assigned: z.enum(["me", "none"]).optional(),
  tag: z.string().regex(/^\d+$/).optional(),
  status: z.enum(["abierto", "cerrado"]).optional(),
  channel: z.enum(["whatsapp", "instagram"]).optional(),
});
router.get("/whatsapp/conversations", requireUser, async (req, res) => {
  const q = ListQuery.safeParse(req.query);
  if (!q.success) throw new UserFacingError("Filtros inválidos.");
  res.json(await waConversationList(req.user!.username, {
    search: q.data.search ?? "", unread: q.data.unread === "true", page: q.data.page ? positiveId(q.data.page) : 1,
    assigned: q.data.assigned, userId: req.user!.id, tagId: q.data.tag ? Number(q.data.tag) : undefined, status: q.data.status, channel: q.data.channel,
  }));
});
router.get("/whatsapp/conversations/:id/messages", requireUser, async (req, res) => {
  res.json(await waMessages(positiveId(req.params.id), req.user!.username,
    req.query.before == null ? undefined : positiveId(req.query.before)));
});
const ReadBody = z.object({ throughMessageId: z.number().int().min(1).max(2147483647) }).strict();
router.post("/whatsapp/conversations/:id/read", requireUser, async (req, res) => {
  const body = ReadBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Marcador de lectura inválido.");
  res.json(await waMarkRead(positiveId(req.params.id), req.user!.username, body.data.throughMessageId));
});
const ReplyBody = z.object({ text: z.string().min(1).max(4096), clientRequestId: z.string().uuid() }).strict();
router.post("/whatsapp/conversations/:id/messages", requireUser, async (req, res) => {
  const body = ReplyBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("El mensaje o el identificador del intento no son válidos.");
  res.json(await waSendReply(positiveId(req.params.id), body.data.text, body.data.clientRequestId, req.user!.username, req.user!.name));
});

export default router;

import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { UserFacingError } from "../lib/errors.js";
import { requireRole, requireUser } from "../lib/auth.js";
import { lookupMember } from "../lib/members.js";
import { positiveId } from "./whatsapp.js";

const router = Router();
router.use(requireUser);

async function conversationExists(id: number) {
  const { rows } = await db().query(`SELECT c.id,c.contact_phone,a.channel FROM whatsapp_conversations c
    JOIN whatsapp_accounts a ON a.id=c.account_id WHERE c.id=$1`, [id]);
  if (!rows[0]) throw new UserFacingError("La conversación no existe.", 404);
  return rows[0];
}

// Asignar / liberar
const AssignBody = z.object({ userId: z.number().int().positive().nullable() }).strict();
router.post("/conversations/:id/assign", async (req, res) => {
  const id = positiveId(req.params.id);
  const body = AssignBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Asignación inválida.");
  await conversationExists(id);
  if (body.data.userId) {
    const { rows } = await db().query("SELECT 1 FROM users WHERE id=$1 AND active", [body.data.userId]);
    if (!rows.length) throw new UserFacingError("Ese usuario no existe o está inactivo.");
  }
  await db().query("UPDATE whatsapp_conversations SET assigned_to=$2 WHERE id=$1", [id, body.data.userId]);
  res.json({ success: true });
});

// Abrir / cerrar
const StatusBody = z.object({ status: z.enum(["abierto", "cerrado"]) }).strict();
router.post("/conversations/:id/status", async (req, res) => {
  const id = positiveId(req.params.id);
  const body = StatusBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Estado inválido.");
  await conversationExists(id);
  await db().query("UPDATE whatsapp_conversations SET status=$2 WHERE id=$1", [id, body.data.status]);
  res.json({ success: true });
});

// Etiquetas
router.get("/tags", async (_req, res) => {
  res.json((await db().query("SELECT id,name,color FROM tags ORDER BY name")).rows);
});
const TagBody = z.object({ name: z.string().trim().min(1).max(30), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict();
router.post("/tags", requireRole("admin"), async (req, res) => {
  const body = TagBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Nombre (hasta 30 letras) y color válidos.");
  const { rows } = await db().query(`INSERT INTO tags(name,color) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET color=EXCLUDED.color
    RETURNING id,name,color`, [body.data.name, body.data.color]);
  res.json(rows[0]);
});
router.delete("/tags/:id", requireRole("admin"), async (req, res) => {
  await db().query("DELETE FROM tags WHERE id=$1", [positiveId(req.params.id)]);
  res.json({ success: true });
});
const ConvTagsBody = z.object({ tagIds: z.array(z.number().int().positive()).max(20) }).strict();
router.put("/conversations/:id/tags", async (req, res) => {
  const id = positiveId(req.params.id);
  const body = ConvTagsBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Etiquetas inválidas.");
  await conversationExists(id);
  await db().transaction(async tx => {
    await tx.query("DELETE FROM conversation_tags WHERE conversation_id=$1", [id]);
    for (const tagId of new Set(body.data.tagIds))
      await tx.query(`INSERT INTO conversation_tags(conversation_id,tag_id) SELECT $1,id FROM tags WHERE id=$2
        ON CONFLICT DO NOTHING`, [id, tagId]);
  });
  res.json({ success: true });
});

// Notas internas
router.get("/conversations/:id/notes", async (req, res) => {
  const id = positiveId(req.params.id);
  await conversationExists(id);
  const { rows } = await db().query(`SELECT id,author_name AS "authorName",user_id AS "userId",text,created_at AS "createdAt"
    FROM conversation_notes WHERE conversation_id=$1 ORDER BY id DESC LIMIT 100`, [id]);
  res.json(rows);
});
const NoteBody = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
router.post("/conversations/:id/notes", async (req, res) => {
  const id = positiveId(req.params.id);
  const body = NoteBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Escribí una nota de hasta 2000 caracteres.");
  await conversationExists(id);
  const { rows } = await db().query(`INSERT INTO conversation_notes(conversation_id,user_id,author_name,text) VALUES($1,$2,$3,$4)
    RETURNING id,author_name AS "authorName",user_id AS "userId",text,created_at AS "createdAt"`,
    [id, req.user!.id, req.user!.name, body.data.text]);
  res.json(rows[0]);
});
router.delete("/notes/:id", async (req, res) => {
  const id = positiveId(req.params.id);
  // Cada uno borra sus notas; el admin, cualquiera.
  const { rows } = await db().query(`DELETE FROM conversation_notes WHERE id=$1 AND (user_id=$2 OR $3) RETURNING id`,
    [id, req.user!.id, req.user!.role === "admin"]);
  if (!rows.length) throw new UserFacingError("No podés borrar esa nota.", 403);
  res.json({ success: true });
});

// Ficha del socio
router.get("/conversations/:id/member", async (req, res) => {
  const conversation = await conversationExists(positiveId(req.params.id));
  // En Instagram no hay teléfono: no se puede buscar al socio automáticamente.
  if (conversation.channel === "instagram") { res.json({ configured: true, error: "En Instagram no hay teléfono para buscar al socio." }); return; }
  res.json(await lookupMember(conversation.contact_phone));
});

export default router;

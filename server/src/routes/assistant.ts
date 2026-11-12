import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { UserFacingError } from "../lib/errors.js";
import { requireRole } from "../lib/auth.js";
import { answer, assistantConfigured } from "../lib/assistant/claude.js";
import { positiveId } from "./whatsapp.js";

// Se monta en /api/assistant. Lo usan Administración, Ventas y el rol "Solo asistente".
const router = Router();
router.use(requireRole("admin", "vendedor", "asistente"));

const HOURLY_LIMIT = 60;    // preguntas por persona por hora (control de costos)
const HISTORY_LIMIT = 20;   // mensajes anteriores que se le pasan a Claude

router.get("/status", (_req, res) => {
  res.json({ configured: assistantConfigured(), mainAppConfigured: Boolean(process.env.MAIN_APP_URL && process.env.MAIN_APP_TOKEN) });
});

router.get("/chats", async (req, res) => {
  const { rows } = await db().query(`SELECT id,title,updated_at AS "updatedAt" FROM assistant_chats
    WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`, [req.user!.id]);
  res.json(rows);
});

async function ownChat(id: number, userId: number) {
  const { rows } = await db().query("SELECT id FROM assistant_chats WHERE id=$1 AND user_id=$2", [id, userId]);
  if (!rows[0]) throw new UserFacingError("Ese chat no existe.", 404);
}

router.get("/chats/:id", async (req, res) => {
  const id = positiveId(req.params.id);
  await ownChat(id, req.user!.id);
  const { rows } = await db().query(`SELECT id,role,text,tools,created_at AS "createdAt" FROM assistant_messages
    WHERE chat_id=$1 ORDER BY id`, [id]);
  res.json(rows);
});

router.delete("/chats/:id", async (req, res) => {
  const id = positiveId(req.params.id);
  await ownChat(id, req.user!.id);
  await db().query("DELETE FROM assistant_chats WHERE id=$1", [id]);
  res.json({ success: true });
});

const AskBody = z.object({
  chatId: z.number().int().positive().nullable().optional(),
  question: z.string().trim().min(1).max(2000),
}).strict();

router.post("/ask", async (req, res) => {
  const body = AskBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Escribí una pregunta de hasta 2000 caracteres.");
  const user = req.user!;
  const { question } = body.data;

  const { rows: [usage] } = await db().query(`SELECT count(*)::int AS n FROM assistant_messages m JOIN assistant_chats c ON c.id=m.chat_id
    WHERE c.user_id=$1 AND m.role='user' AND m.created_at>now()-interval '1 hour'`, [user.id]);
  if (usage.n >= HOURLY_LIMIT) throw new UserFacingError(`Llegaste al límite de ${HOURLY_LIMIT} preguntas por hora.`, 429);

  let chatId = body.data.chatId ?? null;
  let history: { role: "user" | "assistant"; text: string }[] = [];
  if (chatId) {
    await ownChat(chatId, user.id);
    const { rows } = await db().query(`SELECT role,text FROM (SELECT id,role,text FROM assistant_messages WHERE chat_id=$1
      ORDER BY id DESC LIMIT ${HISTORY_LIMIT}) t ORDER BY id`, [chatId]);
    history = rows;
    if (history[0]?.role === "assistant") history.shift(); // Claude necesita que empiece el usuario
  }

  const result = await answer(user, history, question);

  if (!chatId) {
    const title = question.length > 60 ? `${question.slice(0, 57)}…` : question;
    chatId = (await db().query("INSERT INTO assistant_chats(user_id,title) VALUES($1,$2) RETURNING id", [user.id, title])).rows[0].id;
  }
  const message = await db().transaction(async tx => {
    await tx.query("INSERT INTO assistant_messages(chat_id,role,text) VALUES($1,'user',$2)", [chatId, question]);
    const { rows } = await tx.query(`INSERT INTO assistant_messages(chat_id,role,text,tools,usage) VALUES($1,'assistant',$2,$3,$4)
      RETURNING id,role,text,tools,created_at AS "createdAt"`, [chatId, result.text, JSON.stringify(result.tools), JSON.stringify(result.usage ?? null)]);
    await tx.query("UPDATE assistant_chats SET updated_at=now() WHERE id=$1", [chatId]);
    return rows[0];
  });
  res.json({ chatId, message });
});

// Registro de consultas (solo Administración): quién preguntó qué.
router.get("/log", requireRole("admin"), async (_req, res) => {
  const { rows } = await db().query(`SELECT m.id,u.name AS "userName",m.text AS question,m.created_at AS "createdAt",
      (SELECT a.tools FROM assistant_messages a WHERE a.chat_id=m.chat_id AND a.id>m.id AND a.role='assistant' ORDER BY a.id LIMIT 1) AS tools,
      (SELECT a.usage FROM assistant_messages a WHERE a.chat_id=m.chat_id AND a.id>m.id AND a.role='assistant' ORDER BY a.id LIMIT 1) AS usage
    FROM assistant_messages m JOIN assistant_chats c ON c.id=m.chat_id JOIN users u ON u.id=c.user_id
    WHERE m.role='user' ORDER BY m.id DESC LIMIT 200`);
  res.json(rows);
});

export default router;

import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { UserFacingError } from "../lib/errors.js";
import {
  COOKIE, createSession, destroySession, hashPassword, readCookie, requireRole, requireUser,
  sessionCookie, validPassword, verifyPassword,
} from "../lib/auth.js";

const router = Router();

// Límite simple de intentos de login por IP+usuario.
const attempts = new Map<string, { count: number; until: number }>();
function checkAttempts(key: string) {
  const a = attempts.get(key);
  if (a && a.count >= 5 && Date.now() < a.until) throw new UserFacingError("Demasiados intentos. Probá en 15 minutos.", 429);
}
function failAttempt(key: string) {
  const a = attempts.get(key);
  const count = a && Date.now() < a.until ? a.count + 1 : 1;
  attempts.set(key, { count, until: Date.now() + 15 * 60 * 1000 });
}

const LoginBody = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) });
router.post("/auth/login", async (req, res) => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Completá usuario y contraseña.");
  const username = body.data.username.trim().toLowerCase();
  const key = `${req.ip}:${username}`;
  checkAttempts(key);
  const { rows: [user] } = await db().query("SELECT * FROM users WHERE username=$1 AND active", [username]);
  if (!user || !(await verifyPassword(body.data.password, user.password_hash))) {
    failAttempt(key);
    throw new UserFacingError("Usuario o contraseña incorrectos.", 401);
  }
  attempts.delete(key);
  sessionCookie(res, await createSession(user.id));
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role });
});

router.post("/auth/logout", async (req, res) => {
  await destroySession(readCookie(req, COOKIE));
  sessionCookie(res, null);
  res.json({ success: true });
});

router.get("/auth/me", requireUser, (req, res) => { res.json(req.user); });

const PasswordBody = z.object({ current: z.string().max(200), next: z.string().max(200) });
router.post("/auth/password", requireUser, async (req, res) => {
  const body = PasswordBody.safeParse(req.body);
  if (!body.success || !validPassword(body.data.next)) throw new UserFacingError("La nueva contraseña debe tener al menos 10 caracteres.");
  const { rows: [user] } = await db().query("SELECT password_hash FROM users WHERE id=$1", [req.user!.id]);
  if (!(await verifyPassword(body.data.current, user.password_hash))) throw new UserFacingError("La contraseña actual no es correcta.", 401);
  await db().query("UPDATE users SET password_hash=$2 WHERE id=$1", [req.user!.id, await hashPassword(body.data.next)]);
  // Cierra las demás sesiones.
  await db().query("DELETE FROM sessions WHERE user_id=$1", [req.user!.id]);
  sessionCookie(res, await createSession(req.user!.id));
  res.json({ success: true });
});

// --- Usuarios (solo admin) ---
const userColumns = `id,username,name,role,active,created_at AS "createdAt"`;
router.get("/users", requireUser, async (req, res) => {
  // Todos ven la lista básica (para asignar chats); solo admin ve inactivos.
  const all = req.user!.role === "admin";
  const { rows } = await db().query(`SELECT ${userColumns} FROM users ${all ? "" : "WHERE active"} ORDER BY active DESC,name`);
  res.json(rows);
});

const Role = z.enum(["admin", "vendedor", "recepcion", "asistente"]);
const CreateUser = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/),
  name: z.string().trim().min(1).max(80),
  role: Role,
  password: z.string().max(200),
});
router.post("/users", requireRole("admin"), async (req, res) => {
  const body = CreateUser.safeParse(req.body);
  if (!body.success) throw new UserFacingError("Revisá los datos: usuario de 3 a 40 letras, números, punto o guion.");
  if (!validPassword(body.data.password)) throw new UserFacingError("La contraseña debe tener al menos 10 caracteres.");
  const exists = await db().query("SELECT 1 FROM users WHERE username=$1", [body.data.username]);
  if (exists.rows.length) throw new UserFacingError("Ese usuario ya existe.", 409);
  const { rows } = await db().query(`INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING ${userColumns}`,
    [body.data.username, body.data.name, body.data.role, await hashPassword(body.data.password)]);
  res.json(rows[0]);
});

const UpdateUser = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: Role.optional(),
  active: z.boolean().optional(),
  password: z.string().max(200).optional(),
});
router.patch("/users/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const body = UpdateUser.safeParse(req.body);
  if (!Number.isInteger(id) || !body.success) throw new UserFacingError("Datos inválidos.");
  const b = body.data;
  if (id === req.user!.id && (b.active === false || (b.role && b.role !== "admin")))
    throw new UserFacingError("No podés quitarte el rol de admin ni desactivarte a vos mismo.");
  if (b.password !== undefined && !validPassword(b.password)) throw new UserFacingError("La contraseña debe tener al menos 10 caracteres.");
  const { rows } = await db().query(`UPDATE users SET name=COALESCE($2,name),role=COALESCE($3,role),active=COALESCE($4,active),
    password_hash=COALESCE($5,password_hash) WHERE id=$1 RETURNING ${userColumns}`,
    [id, b.name ?? null, b.role ?? null, b.active ?? null, b.password ? await hashPassword(b.password) : null]);
  if (!rows[0]) throw new UserFacingError("El usuario no existe.", 404);
  if (b.active === false || b.password) await db().query("DELETE FROM sessions WHERE user_id=$1", [id]);
  res.json(rows[0]);
});

export default router;

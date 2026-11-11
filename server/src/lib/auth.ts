import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { db } from "../db.js";
import { UserFacingError } from "./errors.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const COOKIE = "crm_session";
const SESSION_DAYS = 14;

export type Role = "admin" | "vendedor" | "recepcion";
export type SessionUser = { id: number; username: string; name: string; role: Role };
declare global { namespace Express { interface Request { user?: SessionUser; rawBody?: Buffer } } }

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [kind, saltHex, hashHex] = stored.split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}
export function validPassword(password: string) {
  return password.length >= 10 && password.length <= 200;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createSession(userId: number) {
  const token = randomBytes(32).toString("base64url");
  await db().query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '${SESSION_DAYS} days')`,
    [sha256(token), userId]);
  await db().query("DELETE FROM sessions WHERE expires_at<now()");
  return token;
}
export async function destroySession(token: string | undefined) {
  if (token) await db().query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
}
export function sessionCookie(res: Response, token: string | null) {
  const secure = process.env.NODE_ENV === "production";
  res.cookie(COOKIE, token ?? "", {
    httpOnly: true, sameSite: "strict", secure, path: "/",
    maxAge: token ? SESSION_DAYS * 24 * 60 * 60 * 1000 : 0,
  });
}
export function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Carga el usuario de la sesión, si hay. */
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const { rows } = await db().query(`SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`, [sha256(token)]);
    if (rows[0]) req.user = rows[0];
  }
  next();
}
export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new UserFacingError("Iniciá sesión.", 401);
  next();
}
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new UserFacingError("Iniciá sesión.", 401);
    if (!roles.includes(req.user.role)) throw new UserFacingError("No tenés permiso para esto.", 403);
    next();
  };
}

/** Crea el primer admin desde variables de entorno si no hay ningún usuario. */
export async function ensureFirstAdmin() {
  const { rows } = await db().query("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) return;
  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn("No hay usuarios. Definí ADMIN_USERNAME y ADMIN_PASSWORD para crear el primer admin.");
    return;
  }
  if (!validPassword(password)) throw new Error("ADMIN_PASSWORD debe tener al menos 10 caracteres.");
  await db().query("INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,'admin',$3)",
    [username, process.env.ADMIN_NAME?.trim() || "Administrador", await hashPassword(password)]);
  console.log(`Admin inicial creado: ${username}`);
}

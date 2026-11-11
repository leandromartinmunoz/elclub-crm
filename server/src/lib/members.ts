/**
 * Ficha del socio desde la app de El Club (solo lectura).
 * La app expone GET /api/crm/socio?phone=... protegido con MAIN_APP_TOKEN.
 * Si no está configurado, el CRM funciona igual, sin ficha.
 */
export type MemberCard = {
  name: string;
  memberId?: string | number;
  branch?: string;
  plan?: string;
  status?: string;
  expiresAt?: string | null;
  debt?: number | null;
  url?: string;
};
export type MemberLookup =
  | { configured: false }
  | { configured: true; found: false }
  | { configured: true; found: true; member: MemberCard }
  | { configured: true; error: string };

const cache = new Map<string, { at: number; value: MemberLookup }>();
const TTL = 5 * 60 * 1000;

export async function lookupMember(phone: string): Promise<MemberLookup> {
  const base = process.env.MAIN_APP_URL, token = process.env.MAIN_APP_TOKEN;
  if (!base || !token) return { configured: false };
  const hit = cache.get(phone);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value: MemberLookup;
  try {
    const url = new URL("/api/crm/socio", base);
    url.searchParams.set("phone", phone);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (response.status === 404) value = { configured: true, found: false };
    else if (!response.ok) value = { configured: true, error: "La app de El Club no respondió bien." };
    else {
      const data = await response.json() as any;
      value = data?.name ? { configured: true, found: true, member: data as MemberCard } : { configured: true, found: false };
    }
  } catch {
    value = { configured: true, error: "No se pudo consultar la app de El Club." };
  }
  if (!("error" in value)) cache.set(phone, { at: Date.now(), value });
  return value;
}

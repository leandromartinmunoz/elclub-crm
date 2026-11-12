export type Role = "admin" | "vendedor" | "recepcion";
export type User = { id: number; username: string; name: string; role: Role; active?: boolean };
export type Tag = { id: number; name: string; color: string };
export type Channel = "whatsapp" | "instagram";
export type Conversation = {
  id: number; accountId: string; channel: Channel; accountLabel: string; contactPhone: string; contactName: string; preview: string;
  lastMessageAt: string; lastInboundAt: string | null; replyUntil: string | null; unreadCount: number;
  status: "abierto" | "cerrado"; assignedTo: number | null; assignedName: string | null; tags: Tag[];
};
export type Message = {
  id: number; conversationId: number; direction: "inbound" | "outbound"; type: string; text: string;
  status: string; occurredAt: string; senderName: string | null; error: string | null;
};
export type Note = { id: number; authorName: string; userId: number | null; text: string; createdAt: string };
export type MemberLookup =
  | { configured: false }
  | { configured: true; found: false }
  | { configured: true; error: string }
  | { configured: true; found: true; member: { name: string; branch?: string; plan?: string; status?: string; expiresAt?: string | null; debt?: number | null; url?: string } };
export type WaStatus = {
  accounts: { id: string; channel: Channel; label: string; displayPhone: string; verifiedName: string; lastEventAt: string | null }[];
  instagram: { tokenConfigured: boolean; webhookVerifiedAt: string | null; webhookUrl: string | null };
  canConfigure: boolean; tokenConfigured: boolean; webhookSecure: boolean; webhookVerifiedAt: string | null; webhookUrl: string | null;
};

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") window.dispatchEvent(new Event("crm:logout"));
    throw new ApiError(data?.error ?? "No se pudo completar la acción.", res.status);
  }
  return data as T;
}

export const roleName: Record<Role, string> = { admin: "Administración", vendedor: "Ventas", recepcion: "Recepción" };

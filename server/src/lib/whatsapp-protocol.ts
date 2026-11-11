import { createHmac, timingSafeEqual } from "node:crypto";

export function secureEqual(a: string, b: string) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function validWhatsappSignature(raw: Buffer, signature: string | undefined, secret: string | undefined) {
  return !!secret && !!signature && /^sha256=[a-f0-9]{64}$/.test(signature)
    && secureEqual(signature, `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
}
export function canReplyAt(lastInbound: string | Date | null, now = Date.now()) {
  if (!lastInbound) return false;
  const at = new Date(lastInbound).getTime();
  return Number.isFinite(at) && at <= now && now < at + 24 * 60 * 60 * 1000;
}
export function nextDeliveryStatus(current: string, incoming: string) {
  if (current === "read" || incoming === "read") return "read";
  if (current === "delivered" || incoming === "delivered") return "delivered";
  if (incoming === "failed") return "failed";
  if (current === "failed") return current;
  if (current === "sending" && incoming === "unknown") return "unknown";
  const rank: Record<string, number> = { sending: 0, unknown: 0, accepted: 1, sent: 2 };
  return (rank[incoming] ?? -1) > (rank[current] ?? -1) ? incoming : current;
}
export function whatsappError(code?: number) {
  if (code === 131030) return "Meta no reconoce este destinatario en la lista de prueba. Revisá el número autorizado y su formato.";
  if (code === 131047) return "Pasaron 24 horas desde el último mensaje del contacto. Esperá un nuevo mensaje para responder desde esta bandeja.";
  if (code === 190 || code === 10 || code === 200) return "Revisá el token de WhatsApp (WHATSAPP_ACCESS_TOKEN) en el servidor.";
  if ([130429, 131056, 131048].includes(code ?? 0)) return "Meta limitó temporalmente los envíos. No se volverá a enviar automáticamente.";
  if (code === 131026) return "Meta no pudo entregar el mensaje a este contacto.";
  return "Meta rechazó el envío. Revisá la conexión antes de volver a intentarlo.";
}
type MetaMessage = { accountId: string; providerId: string; phone: string; name: string; type: string; text: string; occurredAt: Date };
type MetaReceipt = { accountId: string; providerId: string; status: string; error: string | null; occurredAt: Date; clientRequestId?: string; recipientPhone?: string };
const obj = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export function parseWhatsappEvents(payload: unknown): { messages: MetaMessage[]; receipts: MetaReceipt[] } {
  const messages: MetaMessage[] = [], receipts: MetaReceipt[] = [];
  if (obj(payload).object !== "whatsapp_business_account") return { messages, receipts };
  for (const entry of array(obj(payload).entry)) for (const change of array(obj(entry).changes)) {
    const value = obj(obj(change).value), accountId = String(obj(value.metadata).phone_number_id ?? "");
    if (!/^\d{5,30}$/.test(accountId)) continue;
    const names = new Map(array(value.contacts).map(v => [String(obj(v).wa_id), String(obj(obj(v).profile).name ?? "").slice(0, 200)]));
    for (const raw of array(value.messages)) {
      const m = obj(raw), phone = String(m.from ?? ""), providerId = String(m.id ?? "");
      const occurredAt = new Date(Number(m.timestamp) * 1000);
      if (!/^\d{5,20}$/.test(phone) || !providerId || providerId.length > 300 || !Number.isFinite(occurredAt.getTime())) continue;
      const type = String(m.type ?? "unknown").slice(0, 40);
      const mediaName: Record<string, string> = { image: "Imagen", audio: "Audio", video: "Video", document: "Documento", sticker: "Sticker", location: "Ubicación", contacts: "Contacto", reaction: "Reacción" };
      const text = type === "text" ? String(obj(m.text).body ?? "")
        : type === "button" ? String(obj(m.button).text ?? "")
        : type === "interactive" ? String(obj(obj(m.interactive).button_reply).title ?? obj(obj(m.interactive).list_reply).title ?? "[Respuesta interactiva]")
        : `[${mediaName[type] ?? "Mensaje no textual"}] ${String(obj(m[type]).caption ?? "")}`.trim();
      messages.push({ accountId, phone, providerId, occurredAt, type, text: text.slice(0, 8192), name: names.get(phone) || phone });
    }
    for (const raw of array(value.statuses)) {
      const r = obj(raw), providerId = String(r.id ?? ""), status = String(r.status ?? "");
      const occurredAt = new Date(Number(r.timestamp) * 1000);
      if (!providerId || providerId.length > 300 || !["sent", "delivered", "read", "failed"].includes(status) || !Number.isFinite(occurredAt.getTime())) continue;
      receipts.push({ accountId, providerId, status, occurredAt, error: status === "failed" ? whatsappError(Number(obj(array(r.errors)[0]).code)) : null,
        clientRequestId: /^[a-f0-9-]{36}$/i.test(String(r.biz_opaque_callback_data)) ? String(r.biz_opaque_callback_data) : undefined,
        recipientPhone: /^\d{5,20}$/.test(String(r.recipient_id)) ? String(r.recipient_id) : undefined });
    }
  }
  if (messages.length + receipts.length > 2000) throw new Error("Too many WhatsApp events");
  return { messages, receipts };
}

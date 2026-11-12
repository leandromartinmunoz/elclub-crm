import { db, type Queryable } from "../db.js";
import { UserFacingError } from "./errors.js";
import { canReplyAt, nextDeliveryStatus, parseWhatsappEvents, whatsappError } from "./whatsapp-protocol.js";
import { whatsappRequest } from "./whatsapp-provider.js";
import { whatsappTestRecipient } from "./whatsapp-recipient.js";
import { instagramError, parseInstagramEvents } from "./instagram-protocol.js";
import { instagramProfile, instagramRequest } from "./instagram-provider.js";

/** Reemplazable en tests. */
export const deps = { whatsappRequest, instagramRequest, instagramProfile };

export const waMessageColumns = `id,conversation_id AS "conversationId",direction,type,text,status,
  occurred_at AS "occurredAt",sender_name AS "senderName",error`;

// $1 = username (para no leídos)
const conversationColumns = `c.id,c.account_id AS "accountId",a.channel,a.label AS "accountLabel",c.contact_phone AS "contactPhone",
  c.contact_name AS "contactName",c.preview,c.last_message_at AS "lastMessageAt",
  c.last_inbound_at AS "lastInboundAt",(c.last_inbound_at+interval '24 hours') AS "replyUntil",
  c.status,c.assigned_to AS "assignedTo",u.name AS "assignedName",
  COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name)
    FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=c.id),'[]'::json) AS tags,
  (SELECT count(*)::int FROM whatsapp_messages m WHERE m.conversation_id=c.id AND m.direction='inbound'
   AND m.id>COALESCE((SELECT through_message_id FROM whatsapp_reads r WHERE r.conversation_id=c.id AND r.username=$1),0)) AS "unreadCount"`;
const conversationFrom = `whatsapp_conversations c JOIN whatsapp_accounts a ON a.id=c.account_id
  LEFT JOIN users u ON u.id=c.assigned_to`;

export async function waConversation(id: number, username: string) {
  const result = await db().query(`SELECT ${conversationColumns} FROM ${conversationFrom} WHERE c.id=$2`, [username, id]);
  if (!result.rows[0]) throw new UserFacingError("La conversación no existe.", 404);
  return result.rows[0];
}

export type ListFilters = {
  search: string; unread: boolean; page: number;
  assigned?: "me" | "none"; userId: number; tagId?: number; status?: "abierto" | "cerrado";
  channel?: "whatsapp" | "instagram";
};
export async function waConversationList(username: string, f: ListFilters) {
  const common = `WITH conversations AS (SELECT ${conversationColumns} FROM ${conversationFrom}
    WHERE ($2::text='' OR c.contact_name ILIKE $2 OR c.contact_phone ILIKE $2)
      AND ($3::text IS NULL OR ($3='me' AND c.assigned_to=$4) OR ($3='none' AND c.assigned_to IS NULL))
      AND ($5::int IS NULL OR EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.conversation_id=c.id AND ct.tag_id=$5))
      AND ($6::text IS NULL OR c.status=$6)
      AND ($7::text IS NULL OR a.channel=$7))`;
  const args = [username, f.search ? `%${f.search.replace(/[\\%_]/g, "\\$&")}%` : "",
    f.assigned ?? null, f.userId, f.tagId ?? null, f.status ?? null, f.channel ?? null];
  const rows = await db().query(`${common} SELECT * FROM conversations WHERE (NOT $8::boolean OR "unreadCount">0)
    ORDER BY "lastMessageAt" DESC,id DESC LIMIT 51 OFFSET $9`, [...args, f.unread, (f.page - 1) * 50]);
  const count = await db().query(`${common} SELECT COALESCE(sum("unreadCount"),0)::int AS total FROM conversations`, args);
  return { items: rows.rows.slice(0, 50), page: f.page, hasMore: rows.rows.length > 50, unreadTotal: count.rows[0].total };
}

export async function waMessages(id: number, username: string, before?: number) {
  const conversation = await waConversation(id, username);
  await db().query(`UPDATE whatsapp_messages SET status='unknown',
    error='No se pudo confirmar el envío. No lo reenvíes: primero verificá si llegó.'
    WHERE conversation_id=$1 AND status='sending' AND occurred_at<now()-interval '1 minute'`, [id]);
  const result = await db().query(`SELECT ${waMessageColumns} FROM whatsapp_messages
    WHERE conversation_id=$1 AND ($2::int IS NULL OR id<$2) ORDER BY id DESC LIMIT 51`, [id, before ?? null]);
  return { conversation, items: result.rows.slice(0, 50).reverse(), hasOlder: result.rows.length > 50 };
}

export async function waMarkRead(id: number, username: string, through: number) {
  const result = await db().query(`INSERT INTO whatsapp_reads(conversation_id,username,through_message_id)
    SELECT conversation_id,$2,id FROM whatsapp_messages WHERE id=$3 AND conversation_id=$1
    ON CONFLICT(conversation_id,username) DO UPDATE SET through_message_id=
      GREATEST(whatsapp_reads.through_message_id,EXCLUDED.through_message_id) RETURNING conversation_id`, [id, username, through]);
  if (!result.rows.length) throw new UserFacingError("El mensaje no pertenece a esta conversación.", 400);
  return { success: true };
}

export async function waIngest(payload: unknown) {
  const events = parseWhatsappEvents(payload);
  return db().transaction(async tx => {
    const configured = new Set((await tx.query("SELECT id FROM whatsapp_accounts")).rows.map(r => r.id));
    let received = 0;
    for (const event of events.messages) {
      if (!configured.has(event.accountId)) continue;
      const { rows: [conversation] } = await tx.query(`INSERT INTO whatsapp_conversations
        (account_id,contact_phone,contact_name,last_message_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(account_id,contact_phone) DO UPDATE SET contact_name=
          CASE WHEN EXCLUDED.contact_name<>EXCLUDED.contact_phone THEN EXCLUDED.contact_name ELSE whatsapp_conversations.contact_name END
        RETURNING id`, [event.accountId, event.phone, event.name, event.occurredAt]);
      const inserted = await tx.query(`INSERT INTO whatsapp_messages
        (conversation_id,direction,type,text,status,provider_id,occurred_at)
        VALUES($1,'inbound',$2,$3,'received',$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
        [conversation.id, event.type, event.text, event.providerId, event.occurredAt]);
      if (inserted.rows.length) {
        // Un mensaje nuevo reabre la conversación.
        await tx.query(`UPDATE whatsapp_conversations SET
          preview=CASE WHEN last_message_at<=$2 THEN $3 ELSE preview END,
          last_message_at=GREATEST(last_message_at,$2),
          last_inbound_at=GREATEST(last_inbound_at,$2), status='abierto' WHERE id=$1`,
          [conversation.id, event.occurredAt, event.text.slice(0, 250)]);
        received++;
      }
      await tx.query("UPDATE whatsapp_accounts SET last_event_at=now() WHERE id=$1", [event.accountId]);
    }
    for (const event of events.receipts) {
      if (!configured.has(event.accountId)) continue;
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wa-receipt:${event.providerId}`]);
      await tx.query(`INSERT INTO whatsapp_receipts(provider_id,account_id,status,error,occurred_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [event.providerId, event.accountId, event.status, event.error, event.occurredAt]);
      const old = (await tx.query("SELECT * FROM whatsapp_receipts WHERE provider_id=$1 FOR UPDATE", [event.providerId])).rows[0];
      if (old.account_id !== event.accountId) continue;
      const status = nextDeliveryStatus(old.status, event.status);
      const error = status === "failed" ? event.error ?? old.error : null;
      await tx.query("UPDATE whatsapp_receipts SET status=$2,error=$3,occurred_at=GREATEST(occurred_at,$4) WHERE provider_id=$1",
        [event.providerId, status, error, event.occurredAt]);
      // El dato opaco también concilia un envío cuya respuesta HTTP se perdió.
      if (event.clientRequestId && event.recipientPhone) {
        await tx.query(`UPDATE whatsapp_messages m SET provider_id=$1
          FROM whatsapp_conversations c WHERE m.conversation_id=c.id AND c.account_id=$2 AND c.contact_phone=$3
            AND m.client_request_id=$4 AND m.direction='outbound' AND m.provider_id IS NULL`,
          [event.providerId, event.accountId, event.recipientPhone, event.clientRequestId]);
      }
      const messages = await tx.query(`SELECT m.id,m.status FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id=m.conversation_id
        WHERE m.provider_id=$1 AND c.account_id=$2 FOR UPDATE OF m`, [event.providerId, event.accountId]);
      for (const message of messages.rows) {
        const next = nextDeliveryStatus(message.status, status);
        await tx.query("UPDATE whatsapp_messages SET status=$2,error=$3 WHERE id=$1", [message.id, next, next === "failed" ? error : null]);
      }
      await tx.query("UPDATE whatsapp_accounts SET last_event_at=now() WHERE id=$1", [event.accountId]);
    }
    return { received };
  });
}

export async function waSendReply(id: number, text: string, clientRequestId: string, username: string, senderName: string) {
  text = text.trim();
  if (!text || text.length > 4096) throw new UserFacingError("Escribí un mensaje de entre 1 y 4096 caracteres.");
  const reservation = await db().transaction(async (tx: Queryable) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wa-send:${id}`]);
    const previous = (await tx.query(`SELECT ${waMessageColumns} FROM whatsapp_messages
      WHERE conversation_id=$1 AND client_request_id=$2`, [id, clientRequestId])).rows[0];
    if (previous) {
      if (previous.text !== text) throw new UserFacingError("Ese intento ya corresponde a otro mensaje.", 409);
      return { existing: previous };
    }
    const conversation = (await tx.query(`SELECT c.*,a.channel,a.page_id FROM whatsapp_conversations c
      JOIN whatsapp_accounts a ON a.id=c.account_id WHERE c.id=$1`, [id])).rows[0];
    if (!conversation) throw new UserFacingError("La conversación no existe.", 404);
    if (!canReplyAt(conversation.last_inbound_at)) throw new UserFacingError(whatsappError(131047), 409);
    if (conversation.channel === "instagram" && text.length > 1000)
      throw new UserFacingError("Instagram permite mensajes de hasta 1000 caracteres.");
    const recipientPhone = conversation.channel === "instagram" ? conversation.contact_phone
      : whatsappTestRecipient(conversation.account_id, conversation.contact_phone);
    const saved = await tx.query(`INSERT INTO whatsapp_messages
      (conversation_id,direction,type,text,status,client_request_id,sender_username,sender_name)
      VALUES($1,'outbound','text',$2,'sending',$3,$4,$5) RETURNING id`,
      [id, text, clientRequestId, username, senderName]);
    return { messageId: saved.rows[0].id as number, conversation, recipientPhone };
  });
  if ("existing" in reservation) return reservation.existing;
  const { conversation, messageId, recipientPhone } = reservation;
  let providerId: string | null = null;
  let status = "unknown", error: string | null = "No se pudo confirmar el envío. No lo reenvíes: primero verificá si llegó.";
  try {
    if (conversation.channel === "instagram") {
      const response = await deps.instagramRequest(`/${conversation.page_id}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipientPhone }, message: { text } }),
      });
      const data = await response.json() as any;
      if (!response.ok) { status = "failed"; error = instagramError(data.error?.code, data.error?.error_subcode); }
      else if (typeof data.message_id === "string") { providerId = data.message_id; status = "sent"; error = null; }
    } else {
    const response = await deps.whatsappRequest(`/${conversation.account_id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: recipientPhone,
        type: "text", text: { body: text, preview_url: false }, biz_opaque_callback_data: clientRequestId }),
    });
    const data = await response.json() as any;
    if (!response.ok) { status = "failed"; error = whatsappError(data.error?.code); }
    else if (typeof data.messages?.[0]?.id === "string") { providerId = data.messages[0].id; status = "accepted"; error = null; }
    }
  } catch (e) {
    // Falla ambigua de red: se conserva el pedido y nunca se reintenta solo.
    if (e instanceof UserFacingError) { status = "failed"; error = e.message; }
  }
  return db().transaction(async tx => {
    if (providerId) await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wa-receipt:${providerId}`]);
    const current = (await tx.query("SELECT * FROM whatsapp_messages WHERE id=$1 FOR UPDATE", [messageId])).rows[0];
    const receipt = providerId ? (await tx.query("SELECT * FROM whatsapp_receipts WHERE provider_id=$1 AND account_id=$2",
      [providerId, conversation.account_id])).rows[0] : null;
    const next = receipt?.status ?? nextDeliveryStatus(current.status, status);
    const finalError = receipt ? receipt.error : ["read", "delivered", "sent", "accepted"].includes(next) ? null : error;
    const saved = await tx.query(`UPDATE whatsapp_messages SET provider_id=COALESCE(provider_id,$2),status=$3,error=$4
      WHERE id=$1 RETURNING ${waMessageColumns}`, [messageId, providerId, next, finalError]);
    await tx.query(`UPDATE whatsapp_conversations SET preview=$2,last_message_at=now() WHERE id=$1`, [id, text.slice(0, 250)]);
    return saved.rows[0];
  });
}

/** Mensajes directos de Instagram (entrantes y ecos de lo enviado). */
export async function igIngest(payload: unknown) {
  const events = parseInstagramEvents(payload);
  const unnamed = new Set<number>();
  const result = await db().transaction(async tx => {
    const configured = new Set((await tx.query("SELECT id FROM whatsapp_accounts WHERE channel='instagram'")).rows.map(r => r.id));
    let received = 0;
    for (const event of events) {
      if (!configured.has(event.accountId)) continue;
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ig-msg:${event.providerId}`]);
      const { rows: [conversation] } = await tx.query(`INSERT INTO whatsapp_conversations
        (account_id,contact_phone,contact_name,last_message_at) VALUES($1,$2,$2,$3)
        ON CONFLICT(account_id,contact_phone) DO UPDATE SET account_id=EXCLUDED.account_id
        RETURNING id,contact_name,contact_phone`, [event.accountId, event.contactId, event.occurredAt]);
      if (conversation.contact_name === conversation.contact_phone) unnamed.add(conversation.id);
      let inserted: { rows: any[] };
      if (event.direction === "inbound") {
        inserted = await tx.query(`INSERT INTO whatsapp_messages
          (conversation_id,direction,type,text,status,provider_id,occurred_at)
          VALUES($1,'inbound',$2,$3,'received',$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
          [conversation.id, event.type, event.text, event.providerId, event.occurredAt]);
      } else {
        // Eco: si es un envío del CRM sin confirmar, lo concilia; si se mandó desde la app de Instagram, lo agrega.
        inserted = { rows: [] };
        const matched = await tx.query(`UPDATE whatsapp_messages SET provider_id=$2,status='sent',error=NULL
          WHERE id=(SELECT id FROM whatsapp_messages WHERE conversation_id=$1 AND direction='outbound'
            AND provider_id IS NULL AND text=$3 AND status IN ('sending','unknown') ORDER BY id LIMIT 1) RETURNING id`,
          [conversation.id, event.providerId, event.text]);
        if (!matched.rows.length) {
          inserted = await tx.query(`INSERT INTO whatsapp_messages
            (conversation_id,direction,type,text,status,provider_id,occurred_at,sender_name)
            VALUES($1,'outbound',$2,$3,'sent',$4,$5,'Desde Instagram') ON CONFLICT DO NOTHING RETURNING id`,
            [conversation.id, event.type, event.text, event.providerId, event.occurredAt]);
        }
      }
      if (inserted.rows.length) {
        await tx.query(`UPDATE whatsapp_conversations SET
          preview=CASE WHEN last_message_at<=$2 THEN $3 ELSE preview END,
          last_message_at=GREATEST(last_message_at,$2),
          last_inbound_at=CASE WHEN $4 THEN GREATEST(last_inbound_at,$2) ELSE last_inbound_at END,
          status=CASE WHEN $4 THEN 'abierto' ELSE status END WHERE id=$1`,
          [conversation.id, event.occurredAt, event.text.slice(0, 250), event.direction === "inbound"]);
        if (event.direction === "inbound") received++;
      }
      await tx.query("UPDATE whatsapp_accounts SET last_event_at=now() WHERE id=$1", [event.accountId]);
    }
    return { received };
  });
  // Nombre del contacto (fuera de la transacción; si Meta no responde, queda el identificador).
  for (const id of unnamed) {
    const row = (await db().query("SELECT contact_phone FROM whatsapp_conversations WHERE id=$1", [id])).rows[0];
    const name = row && await deps.instagramProfile(row.contact_phone);
    if (name) await db().query("UPDATE whatsapp_conversations SET contact_name=$2 WHERE id=$1 AND contact_name=contact_phone", [id, name]);
  }
  return result;
}

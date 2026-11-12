import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Channel, type Conversation, type MemberLookup, type Message, type Note, type Tag, type User } from "./api";

const POLL_MS = 5000;
type Scope = "todos" | "me" | "none";

function time(iso: string) {
  const d = new Date(iso), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}
function contactLine(c: Conversation) { return c.channel === "instagram" ? "Instagram" : phone(c.contactPhone); }
function ChannelMark({ channel }: { channel: Channel }) {
  return <span className={`channel ${channel}`} title={channel === "instagram" ? "Instagram" : "WhatsApp"}>{channel === "instagram" ? "IG" : "WA"}</span>;
}
function phone(p: string) { return p.startsWith("549") ? `+54 9 ${p.slice(3, 7)} ${p.slice(7)}` : `+${p}`; }
const statusLabel: Record<string, string> = {
  sending: "Enviando", accepted: "Enviado", sent: "Enviado", delivered: "Entregado", read: "Leído", failed: "No enviado", unknown: "Sin confirmar",
};

export function Inbox({ me }: { me: User }) {
  const [scope, setScope] = useState<Scope>("todos");
  const [unread, setUnread] = useState(false);
  const [status, setStatus] = useState<"abierto" | "cerrado">("abierto");
  const [tag, setTag] = useState<number | "">("");
  const [channel, setChannel] = useState<Channel | "">("");
  const [search, setSearch] = useState("");
  const [list, setList] = useState<Conversation[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [listError, setListError] = useState("");

  useEffect(() => {
    api<Tag[]>("/tags").then(setTags).catch(() => {});
    api<User[]>("/users").then(setUsers).catch(() => {});
  }, []);

  const loadList = useCallback(async () => {
    const q = new URLSearchParams({ status });
    if (scope !== "todos") q.set("assigned", scope);
    if (unread) q.set("unread", "true");
    if (tag) q.set("tag", String(tag));
    if (channel) q.set("channel", channel);
    if (search.trim()) q.set("search", search.trim());
    try {
      const data = await api<{ items: Conversation[]; unreadTotal: number }>(`/whatsapp/conversations?${q}`);
      setList(data.items); setUnreadTotal(data.unreadTotal); setListError("");
    } catch (e) { setListError((e as Error).message); }
  }, [scope, unread, status, tag, channel, search]);

  useEffect(() => {
    const t = setTimeout(loadList, search ? 300 : 0);
    const i = setInterval(loadList, POLL_MS);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [loadList, search]);

  useEffect(() => { document.title = unreadTotal ? `(${unreadTotal}) CRM El Club` : "CRM El Club"; }, [unreadTotal]);

  const current = list.find(c => c.id === selected);

  return (
    <div className={selected ? "inbox has-chat" : "inbox"}>
      <aside className="list-pane" aria-label="Conversaciones">
        <div className="filters">
          <input type="search" placeholder="Buscar nombre o teléfono" value={search} onChange={e => setSearch(e.target.value)} aria-label="Buscar" />
          <div className="segmented" role="group" aria-label="Asignación">
            {([["todos", "Todos"], ["me", "Míos"], ["none", "Sin asignar"]] as const).map(([id, label]) => (
              <button key={id} aria-pressed={scope === id} onClick={() => setScope(id)}>{label}</button>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={unread} onChange={e => setUnread(e.target.checked)} />No leídos{unreadTotal > 0 && <span className="badge">{unreadTotal}</span>}</label>
          <div className="filter-row">
            <select aria-label="Etiqueta" value={tag} onChange={e => setTag(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Etiqueta</option>
              {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select aria-label="Canal" value={channel} onChange={e => setChannel(e.target.value as Channel | "")}>
              <option value="">Canal</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="instagram">Instagram</option>
            </select>
            <select aria-label="Estado" value={status} onChange={e => setStatus(e.target.value as "abierto" | "cerrado")}>
              <option value="abierto">Abiertos</option>
              <option value="cerrado">Cerrados</option>
            </select>
          </div>
        </div>
        {listError && <p className="error pad" role="alert">{listError}</p>}
        <ul className="conversations">
          {list.map(c => (
            <li key={c.id}>
              <button className={c.id === selected ? "conv active" : "conv"} onClick={() => setSelected(c.id)}>
                <span className="conv-top">
                  <span className="conv-name"><ChannelMark channel={c.channel} />{c.contactName}</span>
                  <time>{time(c.lastMessageAt)}</time>
                </span>
                <span className="conv-bottom">
                  <span className="conv-preview">{c.preview || "Sin mensajes"}</span>
                  {c.unreadCount > 0 && <span className="badge" aria-label={`${c.unreadCount} sin leer`}>{c.unreadCount}</span>}
                </span>
                {(c.tags.length > 0 || c.assignedName) && (
                  <span className="conv-meta">
                    {c.tags.map(t => <span key={t.id} className="tag" style={{ "--tag": t.color } as React.CSSProperties}>{t.name}</span>)}
                    {c.assignedName && <span className="assignee">{c.assignedTo === me.id ? "Vos" : c.assignedName}</span>}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {!list.length && !listError && (
          <p className="empty">{search || unread || tag || channel || scope !== "todos" ? "Ningún chat coincide con estos filtros." :
            status === "cerrado" ? "No hay chats cerrados." : "Cuando un cliente escriba al WhatsApp o al Instagram de El Club, el chat aparece acá."}</p>
        )}
      </aside>

      {selected && current ? (
        <Chat key={selected} me={me} conversation={current} tags={tags} users={users}
          onBack={() => setSelected(null)} onChanged={loadList} />
      ) : (
        <section className="chat-empty"><p>Elegí un chat para leerlo y responder.</p></section>
      )}
    </div>
  );
}

function ReplyWindow({ until }: { until: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(i); }, []);
  if (!until) return <div className="window closed">Todavía no escribió: no se puede iniciar la conversación desde acá.</div>;
  const left = new Date(until).getTime() - now;
  if (left <= 0) return <div className="window closed">Pasaron 24 h desde su último mensaje. Hay que esperar a que vuelva a escribir.</div>;
  const hours = Math.floor(left / 3600000), minutes = Math.floor((left % 3600000) / 60000);
  const pct = Math.max(2, Math.min(100, (left / 86400000) * 100));
  return (
    <div className={hours < 3 ? "window low" : "window"} title="Meta permite responder hasta 24 h después del último mensaje del cliente.">
      <span>Podés responder durante {hours > 0 ? `${hours} h ` : ""}{minutes} min</span>
      <span className="lane" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

function Chat({ me, conversation, tags, users, onBack, onChanged }: {
  me: User; conversation: Conversation; tags: Tag[]; users: User[]; onBack: () => void; onChanged: () => void;
}) {
  const id = conversation.id;
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const maxLength = conversation.channel === "instagram" ? 1000 : 4096;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const pendingId = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const lastSeen = useRef(0);

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: Message[] }>(`/whatsapp/conversations/${id}/messages`);
      setMessages(data.items);
      const lastInbound = [...data.items].reverse().find(m => m.direction === "inbound");
      if (lastInbound && lastInbound.id > lastSeen.current) {
        lastSeen.current = lastInbound.id;
        await api(`/whatsapp/conversations/${id}/read`, { body: { throughMessageId: lastInbound.id } });
        onChanged();
      }
    } catch (e) { setError((e as Error).message); }
  }, [id, onChanged]);

  useEffect(() => { load(); const i = setInterval(load, POLL_MS); return () => clearInterval(i); }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [messages.length]);

  const canReply = !!conversation.replyUntil && new Date(conversation.replyUntil).getTime() > Date.now();

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true); setError("");
    pendingId.current ??= crypto.randomUUID(); // mismo id si se reintenta: nunca duplica
    try {
      await api(`/whatsapp/conversations/${id}/messages`, { body: { text: text.trim(), clientRequestId: pendingId.current } });
      setText(""); pendingId.current = null;
      await load(); onChanged();
    } catch (err) { setError((err as Error).message); }
    finally { setSending(false); }
  }

  return (
    <>
      <section className="chat" aria-label={`Chat con ${conversation.contactName}`}>
        <header className="chat-head">
          <button className="back" onClick={onBack} aria-label="Volver a la lista">‹</button>
          <div className="chat-title">
            <h2>{conversation.contactName}</h2>
            <span className="muted"><ChannelMark channel={conversation.channel} />{contactLine(conversation)}</span>
          </div>
          <button className="ghost" onClick={() => setShowInfo(s => !s)} aria-expanded={showInfo}>Ficha</button>
        </header>
        <ReplyWindow until={conversation.replyUntil} />
        <div className="messages" aria-live="polite">
          {messages.map(m => (
            <div key={m.id} className={`msg ${m.direction}`}>
              <p>{m.text}</p>
              <span className="msg-meta">
                {m.direction === "outbound" && m.senderName && <>{m.senderName.split(" ")[0]} · </>}
                {time(m.occurredAt)}
                {m.direction === "outbound" && <> · <span className={`st ${m.status}`}>{statusLabel[m.status] ?? m.status}</span></>}
              </span>
              {m.error && <span className="msg-error">{m.error}</span>}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form className="composer" onSubmit={send}>
          <textarea rows={2} value={text} disabled={!canReply} maxLength={maxLength}
            placeholder={canReply ? "Escribí una respuesta. Enter envía, Shift+Enter hace un salto de línea." : "No se puede responder ahora."}
            onChange={e => { setText(e.target.value); pendingId.current = null; }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Respuesta" />
          <button className="primary" disabled={!canReply || sending || !text.trim()}>{sending ? "Enviando…" : "Enviar"}</button>
        </form>
        {error && <p className="error pad" role="alert">{error}</p>}
      </section>
      <Info me={me} conversation={conversation} tags={tags} users={users} open={showInfo} onClose={() => setShowInfo(false)} onChanged={onChanged} />
    </>
  );
}

function Info({ me, conversation, tags, users, open, onClose, onChanged }: {
  me: User; conversation: Conversation; tags: Tag[]; users: User[]; open: boolean; onClose: () => void; onChanged: () => void;
}) {
  const id = conversation.id;
  const [member, setMember] = useState<MemberLookup | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<MemberLookup>(`/conversations/${id}/member`).then(setMember).catch(() => setMember(null));
    api<Note[]>(`/conversations/${id}/notes`).then(setNotes).catch(() => {});
  }, [id]);

  async function act(work: () => Promise<unknown>) {
    setError("");
    try { await work(); onChanged(); } catch (e) { setError((e as Error).message); }
  }
  const tagIds = conversation.tags.map(t => t.id);

  return (
    <aside className={open ? "info open" : "info"} aria-label="Ficha del contacto">
      <div className="info-head"><h3>Ficha</h3><button className="link info-close" onClick={onClose}>Cerrar</button></div>

      <section>
        <h4>Socio</h4>
        {!member && <p className="muted">Buscando…</p>}
        {member && !member.configured && <p className="muted">La conexión con la app de El Club todavía no está activa.</p>}
        {member && member.configured && "error" in member && <p className="muted">{member.error}</p>}
        {member && member.configured && "found" in member && !member.found && <p className="muted">Este número no figura como socio.</p>}
        {member && member.configured && "found" in member && member.found && (
          <dl className="member">
            <dt>Nombre</dt><dd>{member.member.name}</dd>
            {member.member.branch && <><dt>Sede</dt><dd>{member.member.branch}</dd></>}
            {member.member.plan && <><dt>Plan</dt><dd>{member.member.plan}</dd></>}
            {member.member.status && <><dt>Estado</dt><dd>{member.member.status}</dd></>}
            {member.member.expiresAt && <><dt>Vence</dt><dd>{new Date(member.member.expiresAt).toLocaleDateString("es-AR")}</dd></>}
            {member.member.debt ? <><dt>Deuda</dt><dd className="debt">${member.member.debt.toLocaleString("es-AR")}</dd></> : null}
          </dl>
        )}
      </section>

      <section>
        <h4>Responsable</h4>
        <select value={conversation.assignedTo ?? ""} aria-label="Responsable"
          onChange={e => act(() => api(`/conversations/${id}/assign`, { body: { userId: e.target.value ? Number(e.target.value) : null } }))}>
          <option value="">Sin asignar</option>
          {users.filter(u => u.active !== false).map(u => <option key={u.id} value={u.id}>{u.id === me.id ? `${u.name} (vos)` : u.name}</option>)}
        </select>
      </section>

      <section>
        <h4>Etiquetas</h4>
        <div className="tag-picker">
          {tags.map(t => {
            const on = tagIds.includes(t.id);
            return (
              <button key={t.id} className={on ? "tag on" : "tag"} aria-pressed={on} style={{ "--tag": t.color } as React.CSSProperties}
                onClick={() => act(() => api(`/conversations/${id}/tags`, { method: "PUT", body: { tagIds: on ? tagIds.filter(x => x !== t.id) : [...tagIds, t.id] } }))}>
                {t.name}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h4>Notas internas</h4>
        <form className="note-form" onSubmit={e => { e.preventDefault(); if (!note.trim()) return;
          act(async () => { const n = await api<Note>(`/conversations/${id}/notes`, { body: { text: note } }); setNotes(ns => [n, ...ns]); setNote(""); }); }}>
          <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Solo la ve el equipo" aria-label="Nueva nota" />
          <button className="ghost" disabled={!note.trim()}>Guardar nota</button>
        </form>
        <ul className="notes">
          {notes.map(n => (
            <li key={n.id}>
              <p>{n.text}</p>
              <span className="muted">{n.authorName} · {new Date(n.createdAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
                {(n.userId === me.id || me.role === "admin") && (
                  <button className="link" onClick={() => act(async () => { await api(`/notes/${n.id}`, { method: "DELETE" }); setNotes(ns => ns.filter(x => x.id !== n.id)); })}>Borrar</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        {conversation.status === "abierto"
          ? <button className="ghost wide" onClick={() => act(() => api(`/conversations/${id}/status`, { body: { status: "cerrado" } }))}>Cerrar chat</button>
          : <button className="ghost wide" onClick={() => act(() => api(`/conversations/${id}/status`, { body: { status: "abierto" } }))}>Reabrir chat</button>}
        <p className="muted small">Si el cliente vuelve a escribir, el chat se reabre solo.</p>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </aside>
  );
}

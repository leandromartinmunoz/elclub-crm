import { useEffect, useRef, useState } from "react";
import { api, type User } from "./api";
import { Markdown } from "./Markdown";

type Chat = { id: number; title: string; updatedAt: string };
type ToolCall = { name: string; input: Record<string, unknown>; error?: boolean };
type Msg = { id: number; role: "user" | "assistant"; text: string; tools: ToolCall[]; createdAt: string };
type Status = { configured: boolean; mainAppConfigured: boolean };
type LogRow = { id: number; userName: string; question: string; createdAt: string; tools: ToolCall[] | null };

const SUGGESTIONS = [
  "¿Cuántos socios pagan por débito automático?",
  "¿Quiénes no renovaron el mes pasado?",
  "¿Quiénes cumplen 3 meses entrenando este mes?",
  "¿Qué socios activos no vienen hace más de 15 días?",
  "¿A quiénes se les vence la cuota esta semana?",
];

const toolName: Record<string, string> = {
  resumen_socios: "Resumen", buscar_socios: "Socios", socios_sin_renovar: "Sin renovar",
  vencimientos: "Vencimientos", altas_bajas: "Altas y bajas", ficha_socio: "Ficha",
};
const when = (iso: string) => new Date(iso).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function Assistant({ me }: { me: User }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<LogRow[]>([]);
  const end = useRef<HTMLDivElement>(null);

  const loadChats = () => api<Chat[]>("/assistant/chats").then(setChats).catch(e => setError(e.message));
  useEffect(() => { api<Status>("/assistant/status").then(setStatus).catch(() => {}); loadChats(); }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages, pending]);

  async function open(id: number | null) {
    setChatId(id); setError(""); setShowLog(false);
    setMessages(id ? await api<Msg[]>(`/assistant/chats/${id}`).catch(e => { setError(e.message); return []; }) : []);
  }

  async function ask(question: string) {
    question = question.trim();
    if (!question || pending) return;
    setPending(question); setDraft(""); setError("");
    try {
      const res = await api<{ chatId: number; message: Msg }>("/assistant/ask", { body: { chatId, question } });
      const now = new Date().toISOString();
      setMessages(m => [...m, { id: -Date.now(), role: "user", text: question, tools: [], createdAt: now }, res.message]);
      if (res.chatId !== chatId) setChatId(res.chatId);
      loadChats();
    } catch (e) {
      setError((e as Error).message); setDraft(question);
    } finally { setPending(null); }
  }

  async function remove(id: number) {
    if (!confirm("¿Borrar este chat?")) return;
    await api(`/assistant/chats/${id}`, { method: "DELETE" }).catch(e => setError(e.message));
    if (id === chatId) open(null);
    loadChats();
  }

  return (
    <div className="assistant">
      <aside className="assistant-side">
        <button className="primary wide" onClick={() => open(null)}>Nueva consulta</button>
        <ul className="chat-list">
          {chats.map(c => (
            <li key={c.id} className={c.id === chatId ? "active" : undefined}>
              <button className="chat-link" onClick={() => open(c.id)}>
                <span>{c.title}</span><time>{when(c.updatedAt)}</time>
              </button>
              <button className="chat-del" aria-label={`Borrar ${c.title}`} onClick={() => remove(c.id)}>×</button>
            </li>
          ))}
        </ul>
        {me.role === "admin" && (
          <button className="ghost" onClick={async () => {
            setShowLog(true); setLog(await api<LogRow[]>("/assistant/log").catch(() => []));
          }}>Registro de consultas</button>
        )}
      </aside>

      {showLog ? (
        <section className="page">
          <h1>Registro de consultas</h1>
          <p className="muted">Las últimas 200 preguntas del equipo y qué datos consultó el asistente.</p>
          <table className="table">
            <thead><tr><th>Cuándo</th><th>Quién</th><th>Pregunta</th><th>Consultó</th></tr></thead>
            <tbody>{log.map(r => (
              <tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.userName}</td><td>{r.question}</td>
                <td>{(r.tools ?? []).map(t => toolName[t.name] ?? t.name).join(", ") || "—"}</td></tr>
            ))}</tbody>
          </table>
        </section>
      ) : (
        <section className="assistant-main">
          <div className="assistant-thread">
            {status && (!status.configured || !status.mainAppConfigured) && (
              <p className="notice">
                {!status.configured ? "Falta cargar ANTHROPIC_API_KEY en el servidor. " : ""}
                {!status.mainAppConfigured ? "Falta conectar la app de El Club (MAIN_APP_URL y MAIN_APP_TOKEN)." : ""}
              </p>
            )}
            {!messages.length && !pending && (
              <div className="assistant-empty">
                <h1>¿Qué querés saber?</h1>
                <p className="muted">Preguntá en tus palabras. El asistente consulta los datos de socios de la app de El Club (solo lectura).</p>
                <div className="suggestions">
                  {SUGGESTIONS.map(s => <button key={s} className="ghost" onClick={() => ask(s)}>{s}</button>)}
                </div>
              </div>
            )}
            {messages.map(m => (
              <article key={m.id} className={`turn turn-${m.role}`}>
                {m.role === "user" ? <p>{m.text}</p> : <Markdown text={m.text} />}
                {m.role === "assistant" && m.tools.length > 0 && (
                  <p className="consulted">Consultó: {m.tools.map((t, k) => (
                    <span key={k} className={t.error ? "tool err" : "tool"}>{toolName[t.name] ?? t.name}</span>
                  ))}</p>
                )}
              </article>
            ))}
            {pending && <>
              <article className="turn turn-user"><p>{pending}</p></article>
              <article className="turn turn-assistant thinking" aria-live="polite">Consultando los datos…</article>
            </>}
            <div ref={end} />
          </div>
          {error && <p className="error pad" role="alert">{error}</p>}
          <form className="composer" onSubmit={e => { e.preventDefault(); ask(draft); }}>
            <textarea rows={2} value={draft} maxLength={2000} placeholder="Ej.: ¿cuántos socios de la sede con pileta pagan por débito?"
              aria-label="Pregunta" onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); } }} />
            <button className="primary" disabled={!draft.trim() || !!pending}>Preguntar</button>
          </form>
        </section>
      )}
    </div>
  );
}

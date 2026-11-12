import { useEffect, useState } from "react";
import { api, type WaStatus } from "./api";

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <li className={ok ? "check-ok" : "check-no"}><span aria-hidden="true">{ok ? "✓" : "•"}</span>{children}</li>;
}

export function Settings() {
  const [status, setStatus] = useState<WaStatus | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pageId, setPageId] = useState("");
  const [igError, setIgError] = useState("");
  const [igBusy, setIgBusy] = useState(false);

  const load = () => api<WaStatus>("/whatsapp/status").then(setStatus).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  async function addAccount(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await api("/whatsapp/accounts", { body: { phoneNumberId: phoneNumberId.trim(), label: label.trim() || undefined } }); setPhoneNumberId(""); setLabel(""); await load(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function addInstagram(e: React.FormEvent) {
    e.preventDefault(); setIgBusy(true); setIgError("");
    try { await api("/instagram/accounts", { body: { pageId: pageId.trim() } }); setPageId(""); await load(); }
    catch (err) { setIgError((err as Error).message); }
    finally { setIgBusy(false); }
  }

  if (!status) return <div className="page"><h1>Conexiones</h1>{error ? <p className="error">{error}</p> : <p className="muted">Cargando…</p>}</div>;

  const wa = status.accounts.filter(a => a.channel === "whatsapp"), ig = status.accounts.filter(a => a.channel === "instagram");
  return (
    <div className="page">
      <h1>Conexiones</h1>
      <div className="card">
        <h2>WhatsApp</h2>
        <ul className="checks">
          <Check ok={status.tokenConfigured}>Token propio de Meta cargado en el servidor</Check>
          <Check ok={status.webhookSecure}>Clave del webhook configurada</Check>
          <Check ok={!!status.webhookVerifiedAt}>
            Meta verificó el webhook{status.webhookVerifiedAt && <> el {new Date(status.webhookVerifiedAt).toLocaleString("es-AR")}</>}
          </Check>
          <Check ok={wa.length > 0}>Número de WhatsApp vinculado</Check>
        </ul>
        {status.webhookUrl && <p className="muted">Dirección para Meta: <code>{status.webhookUrl}</code></p>}
        <h3>Números</h3>
        {wa.length === 0 && <p className="muted">Todavía no hay números. Agregá el de El Club con su ID de Meta.</p>}
        <ul className="plain">
          {wa.map(a => (
            <li key={a.id}><strong>{a.label}</strong> <span className="muted">{a.displayPhone} · último evento {a.lastEventAt ? new Date(a.lastEventAt).toLocaleString("es-AR") : "nunca"}</span></li>
          ))}
        </ul>
        <form className="form-grid" onSubmit={addAccount}>
          <label>ID del número (Phone number ID)<input value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} inputMode="numeric" required /></label>
          <label>Nombre para mostrar<input value={label} onChange={e => setLabel(e.target.value)} placeholder="El Club" /></label>
          <button className="primary" disabled={busy || !status.tokenConfigured}>{busy ? "Verificando con Meta…" : "Vincular número"}</button>
        </form>
        {!status.tokenConfigured && <p className="muted small">Primero hay que cargar el token en el servidor.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      <div className="card">
        <h2>Instagram (mensajes directos)</h2>
        <ul className="checks">
          <Check ok={status.instagram.tokenConfigured}>Token de la página de Facebook cargado en el servidor</Check>
          <Check ok={status.webhookSecure}>Clave del webhook configurada</Check>
          <Check ok={!!status.instagram.webhookVerifiedAt}>
            Meta verificó el webhook{status.instagram.webhookVerifiedAt && <> el {new Date(status.instagram.webhookVerifiedAt).toLocaleString("es-AR")}</>}
          </Check>
          <Check ok={ig.length > 0}>Cuenta de Instagram vinculada</Check>
        </ul>
        {status.instagram.webhookUrl && <p className="muted">Dirección para Meta: <code>{status.instagram.webhookUrl}</code></p>}
        <ul className="plain">
          {ig.map(a => (
            <li key={a.id}><strong>{a.label}</strong> <span className="muted">{a.displayPhone} · último evento {a.lastEventAt ? new Date(a.lastEventAt).toLocaleString("es-AR") : "nunca"}</span></li>
          ))}
        </ul>
        <form className="form-grid" onSubmit={addInstagram}>
          <label>ID de la página de Facebook de El Club<input value={pageId} onChange={e => setPageId(e.target.value)} inputMode="numeric" required /></label>
          <button className="primary" disabled={igBusy || !status.instagram.tokenConfigured}>{igBusy ? "Verificando con Meta…" : "Vincular Instagram"}</button>
        </form>
        <p className="muted small">La cuenta de Instagram tiene que ser profesional y estar vinculada a esa página. Se muestran los mensajes nuevos desde que se vincula.</p>
        {igError && <p className="error" role="alert">{igError}</p>}
      </div>
    </div>
  );
}

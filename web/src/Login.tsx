import { useState } from "react";
import { api, type User } from "./api";

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { onLogin(await api<User>("/auth/login", { body: { username, password } })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="brand-mark big">EC</span>
        <h1>CRM El Club</h1>
        <p className="muted">Entrá con tu usuario del equipo.</p>
        <label>Usuario<input autoFocus autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></label>
        <label>Contraseña<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || !username || !password}>{busy ? "Entrando…" : "Entrar"}</button>
      </form>
    </div>
  );
}

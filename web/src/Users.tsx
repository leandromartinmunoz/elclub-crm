import { useEffect, useState } from "react";
import { api, roleName, type Role, type User } from "./api";

export function Users({ me }: { me: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ username: "", name: "", role: "vendedor" as Role, password: "" });
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = () => api<User[]>("/users").then(setUsers).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  async function act(work: () => Promise<unknown>, message: string) {
    setError(""); setDone("");
    try { await work(); setDone(message); await load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="page">
      <h1>Equipo</h1>
      <p className="muted">Cada persona entra con su usuario. Lo que responde queda firmado con su nombre.</p>

      <form className="card form-grid" onSubmit={e => { e.preventDefault();
        act(async () => { await api("/users", { body: form }); setForm({ username: "", name: "", role: "vendedor", password: "" }); }, "Usuario creado."); }}>
        <h2>Sumar a alguien</h2>
        <label>Nombre<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
        <label>Usuario<input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} required
          pattern="[a-zA-Z0-9._\-]{3,40}" title="De 3 a 40 letras, números, punto o guion" /></label>
        <label>Rol<select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Role })}>
          {(["vendedor", "recepcion", "asistente", "admin"] as Role[]).map(r => <option key={r} value={r}>{roleName[r]}</option>)}
        </select></label>
        <label>Contraseña inicial<input type="text" value={form.password} minLength={10} onChange={e => setForm({ ...form, password: e.target.value })} required /></label>
        <button className="primary">Crear usuario</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok" role="status">{done}</p>}

      <table className="table">
        <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th><span className="sr">Acciones</span></th></tr></thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id} className={u.active === false ? "inactive" : undefined}>
              <td>{u.name}{u.id === me.id && <span className="muted"> (vos)</span>}</td>
              <td>{u.username}</td>
              <td>
                <select value={u.role} disabled={u.id === me.id} aria-label={`Rol de ${u.name}`}
                  onChange={e => act(() => api(`/users/${u.id}`, { method: "PATCH", body: { role: e.target.value } }), "Rol actualizado.")}>
                  {(["vendedor", "recepcion", "asistente", "admin"] as Role[]).map(r => <option key={r} value={r}>{roleName[r]}</option>)}
                </select>
              </td>
              <td>{u.active === false ? "Desactivado" : "Activo"}</td>
              <td className="actions">
                <button className="link" onClick={() => {
                  const password = prompt(`Nueva contraseña para ${u.name} (mínimo 10 caracteres):`);
                  if (password) act(() => api(`/users/${u.id}`, { method: "PATCH", body: { password } }), "Contraseña cambiada.");
                }}>Cambiar contraseña</button>
                {u.id !== me.id && (
                  <button className="link" onClick={() => act(() => api(`/users/${u.id}`, { method: "PATCH", body: { active: u.active === false } }),
                    u.active === false ? "Usuario reactivado." : "Usuario desactivado.")}>
                    {u.active === false ? "Reactivar" : "Desactivar"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

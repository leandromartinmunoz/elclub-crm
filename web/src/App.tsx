import { useEffect, useState } from "react";
import { api, roleName, type User } from "./api";
import { Login } from "./Login";
import { Inbox } from "./Inbox";
import { Users } from "./Users";
import { Settings } from "./Settings";

type View = "bandeja" | "equipo" | "ajustes";

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [view, setView] = useState<View>("bandeja");

  useEffect(() => {
    api<User>("/auth/me").then(setUser).catch(() => setUser(null));
    const logout = () => setUser(null);
    window.addEventListener("crm:logout", logout);
    return () => window.removeEventListener("crm:logout", logout);
  }, []);

  if (user === undefined) return <div className="boot" aria-busy="true" />;
  if (!user) return <Login onLogin={setUser} />;

  const views: { id: View; label: string; admin?: boolean }[] = [
    { id: "bandeja", label: "Bandeja" },
    { id: "equipo", label: "Equipo", admin: true },
    { id: "ajustes", label: "WhatsApp", admin: true },
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">EC</span><span>CRM El Club</span></div>
        <nav aria-label="Secciones">
          {views.filter(v => !v.admin || user.role === "admin").map(v => (
            <button key={v.id} className={view === v.id ? "nav-item active" : "nav-item"}
              aria-current={view === v.id ? "page" : undefined} onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </nav>
        <div className="who">
          <span><strong>{user.name}</strong><small>{roleName[user.role]}</small></span>
          <button className="link" onClick={async () => { await api("/auth/logout", { body: {} }).catch(() => {}); setUser(null); }}>Salir</button>
        </div>
      </header>
      <main className="content">
        {view === "bandeja" && <Inbox me={user} />}
        {view === "equipo" && user.role === "admin" && <Users me={user} />}
        {view === "ajustes" && user.role === "admin" && <Settings />}
      </main>
    </div>
  );
}

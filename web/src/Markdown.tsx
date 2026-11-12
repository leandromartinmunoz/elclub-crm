import { Fragment, type ReactNode } from "react";

/**
 * Markdown simple y seguro (sin HTML) para las respuestas del asistente:
 * títulos, párrafos, listas, tablas, **negrita** y `código`.
 */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code>
        : <Fragment key={i}>{part}</Fragment>);
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
const isDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function downloadCsv(head: string[], rows: string[][]) {
  const clean = (v: string) => `"${v.replace(/\*\*/g, "").replace(/"/g, '""')}"`;
  const csv = [head, ...rows].map(r => r.map(clean).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `el-club-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // Tabla
    if (line.trim().startsWith("|") && isDivider(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(
        <div className="md-table" key={out.length}>
          <div className="md-scroll">
            <table className="table">
              <thead><tr>{head.map((h, k) => <th key={k}>{inline(h)}</th>)}</tr></thead>
              <tbody>{rows.map((r, k) => <tr key={k}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "")}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <button className="link small" onClick={() => downloadCsv(head, rows)}>Descargar para Excel ({rows.length} filas)</button>
        </div>);
      continue;
    }
    // Título
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { out.push(<h3 key={out.length}>{inline(heading[2])}</h3>); i++; continue; }
    // Lista
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const List = ordered ? "ol" : "ul";
      out.push(<List key={out.length}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</List>);
      continue;
    }
    // Párrafo
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("|") && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]))
      para.push(lines[i++]);
    if (!para.length) { out.push(<p key={out.length}>{inline(lines[i++])}</p>); continue; }
    out.push(<p key={out.length}>{para.flatMap((p, k) => k ? [<br key={`b${k}`} />, ...inline(p)] : inline(p))}</p>);
  }
  return <div className="md">{out}</div>;
}

// Minimal CSV reader/writer for the purchase list (semicolon separated, optional quotes).

export function parseCsv(text, sep = ';') {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const records = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    records.push({ line: i + 1, fields: splitLine(line, sep) });
  });
  const [head, ...rows] = records;
  return { header: head?.fields ?? [], rows };
}

function splitLine(line, sep) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (c === sep) {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur.trim());
  return fields;
}

export function formatCsv(header, rows, sep = ';') {
  const esc = v => {
    const s = String(v ?? '');
    return s.includes(sep) || s.includes('"') ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [header, ...rows].map(r => r.map(esc).join(sep)).join('\n') + '\n';
}

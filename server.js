// server.js — Backend Express + SQLite (via sql.js) per OrtPWA.
// Persiste i dati in un singolo file (orto.db) montato come volume Docker.

const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
// DB_PATH configurabile via env (default = cartella del progetto, sovrascritto
// dall'entrypoint Docker a /data/orto.db)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'orto.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;
let saveTimer = null;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');

  db.run(`
    CREATE TABLE IF NOT EXISTS vegetables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS harvests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vegetable_id INTEGER NOT NULL,
      weight REAL NOT NULL,
      date TEXT NOT NULL DEFAULT (date('now','localtime')),
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (vegetable_id) REFERENCES vegetables(id) ON DELETE CASCADE
    )
  `);

  // Crea /data se serve (utile anche fuori Docker)
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  saveDB();
  console.log('Database initialized at', DB_PATH);
}

// Salva con un piccolo debounce per evitare scritture I/O continue sotto carico
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('saveDB error:', e.message);
    }
  }, 50);
}

// Salva sincrono (usato in caso di uscita)
function saveDBSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('saveDBSync error:', e.message);
  }
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function lastInsertId() {
  const result = db.exec('SELECT last_insert_rowid()');
  return result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : null;
}

// --- Vegetables ---

app.get('/api/vegetables', (req, res) => {
  res.json(queryAll('SELECT id, name FROM vegetables ORDER BY name COLLATE NOCASE'));
});

app.post('/api/vegetables', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obbligatorio' });
  try {
    db.run('INSERT INTO vegetables (name) VALUES (?)', [name]);
    const id = lastInsertId();
    saveDB();
    res.json({ id, name });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      const existing = queryAll('SELECT id, name FROM vegetables WHERE name = ?', [name]);
      if (existing.length > 0) return res.json(existing[0]);
      return res.status(500).json({ error: 'Duplicate ma non trovato' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/vegetables/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (queryAll('SELECT id FROM vegetables WHERE id = ?', [id]).length === 0) {
    return res.status(404).json({ error: 'Ortaggio non trovato' });
  }
  try {
    db.run('UPDATE vegetables SET name = ? WHERE id = ?', [name, id]);
    saveDB();
    res.json({ id, name });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Esiste già un ortaggio con questo nome' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/vegetables/:id', (req, res) => {
  db.run('DELETE FROM vegetables WHERE id = ?', [parseInt(req.params.id)]);
  saveDB();
  res.json({ ok: true });
});

// --- Export CSV ---

app.get('/api/export/csv', (req, res) => {
  const rows = queryAll(`
    SELECT h.id, v.name AS vegetable_name, h.weight, h.date, h.notes, h.created_at
    FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
    ORDER BY h.date DESC, h.id DESC
  `);
  const header = 'ID,Ortaggio,Peso (kg),Data,Note,Creato il\n';
  const body = rows.map(r => {
    const name = (r.vegetable_name || '').replace(/"/g, '""');
    const notes = (r.notes || '').replace(/"/g, '""');
    return `${r.id},"${name}",${r.weight},${r.date},"${notes}",${r.created_at}`;
  }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="raccolto-orto-' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send('\uFEFF' + header + body);
});

// --- Harvests ---

app.get('/api/harvests', (req, res) => {
  res.json(queryAll(`
    SELECT h.id, h.vegetable_id, v.name AS vegetable_name, h.weight, h.date, h.notes
    FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
    ORDER BY h.date DESC, h.id DESC
  `));
});

app.post('/api/harvests', (req, res) => {
  const vegId = parseInt(req.body.vegetable_id);
  const weight = parseFloat(req.body.weight);
  if (isNaN(vegId) || isNaN(weight) || weight <= 0) {
    return res.status(400).json({ error: 'Ortaggio e peso validi obbligatori' });
  }
  if (queryAll('SELECT id FROM vegetables WHERE id = ?', [vegId]).length === 0) {
    return res.status(400).json({ error: 'Ortaggio non trovato' });
  }
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  try {
    db.run('INSERT INTO harvests (vegetable_id, weight, date, notes) VALUES (?, ?, ?, ?)',
      [vegId, weight, date, req.body.notes || '']);
    const id = lastInsertId();
    saveDB();
    const row = queryAll(`
      SELECT h.id, h.vegetable_id, v.name AS vegetable_name, h.weight, h.date, h.notes
      FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
      WHERE h.id = ?`, [id]);
    if (row.length === 0) return res.status(500).json({ error: 'Errore post-insert' });
    res.json(row[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/harvests/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const vegId = parseInt(req.body.vegetable_id);
  const weight = parseFloat(req.body.weight);
  if (isNaN(id) || isNaN(vegId) || isNaN(weight) || weight <= 0) {
    return res.status(400).json({ error: 'Dati non validi' });
  }
  try {
    db.run('UPDATE harvests SET vegetable_id = ?, weight = ?, date = ?, notes = ? WHERE id = ?',
      [vegId, weight, req.body.date, req.body.notes || '', id]);
    saveDB();
    const row = queryAll(`
      SELECT h.id, h.vegetable_id, v.name AS vegetable_name, h.weight, h.date, h.notes
      FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
      WHERE h.id = ?`, [id]);
    if (row.length === 0) return res.status(404).json({ error: 'Non trovato' });
    res.json(row[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/harvests/:id', (req, res) => {
  db.run('DELETE FROM harvests WHERE id = ?', [parseInt(req.params.id)]);
  saveDB();
  res.json({ ok: true });
});

// --- Stats ---

app.get('/api/stats', (req, res) => {
  const byVeg = queryAll(`
    SELECT v.name, SUM(h.weight) AS total_weight, COUNT(*) AS count
    FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
    GROUP BY h.vegetable_id
    ORDER BY total_weight DESC
  `);
  const grandTotalRow = queryAll('SELECT COALESCE(SUM(weight), 0) AS total FROM harvests');
  const grandTotal = grandTotalRow.length > 0 ? grandTotalRow[0].total : 0;
  const recent = queryAll(`
    SELECT h.id, h.vegetable_id, v.name AS vegetable_name, h.weight, h.date, h.notes
    FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
    ORDER BY h.date DESC, h.id DESC LIMIT 10
  `);
  const monthly = queryAll(`
    SELECT strftime('%Y-%m', h.date) AS month, SUM(h.weight) AS total_weight, COUNT(*) AS count
    FROM harvests h
    GROUP BY month
    ORDER BY month DESC
  `);
  res.json({ by_vegetable: byVeg, grand_total: grandTotal, recent, monthly });
});

// SPA fallback (per la PWA, ogni route non-API serve index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Salva il DB in modo sincrono all'uscita
process.on('SIGINT', () => { saveDBSync(); process.exit(0); });
process.on('SIGTERM', () => { saveDBSync(); process.exit(0); });

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌿 OrtPWA running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});

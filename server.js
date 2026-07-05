const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'organizaciondaso.sqlite');
const BACKUP_PATH = DB_PATH + '.bak';

fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

function parseJSON(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function normalizeCollection(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function persistDatabase() {
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, BACKUP_PATH);
  }
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function getState() {
  const result = db.exec('SELECT users_json, projects_json, state_version, updated_at FROM app_state WHERE id = 1');
  const values = result[0]?.values?.[0] || ['{}', '{}', 0, ''];
  return {
    users: parseJSON(values[0], {}),
    projects: parseJSON(values[1], {}),
    version: Number(values[2]) || 0,
    updatedAt: values[3] || '',
  };
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/db', (req, res) => {
  res.json(getState());
});

app.post('/api/db', (req, res) => {
  const users = normalizeCollection(req.body?.users);
  const projects = normalizeCollection(req.body?.projects);
  const baseVersion = Number(req.body?.version);
  const current = getState();

  if (Number.isFinite(baseVersion) && baseVersion !== current.version) {
    return res.status(409).json({
      ok: false,
      reason: 'version_conflict',
      message: 'La base online cambio desde tu ultima lectura.',
      state: current,
    });
  }

  db.run(
    'UPDATE app_state SET users_json = ?, projects_json = ?, state_version = state_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [JSON.stringify(users), JSON.stringify(projects)]
  );
  persistDatabase();

  res.json({ ok: true, ...getState() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      users_json TEXT NOT NULL DEFAULT '{}',
      projects_json TEXT NOT NULL DEFAULT '{}',
      state_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO app_state (id, users_json, projects_json)
    VALUES (1, '{}', '{}');
  `);

  const columns = db.exec('PRAGMA table_info(app_state)');
  const names = new Set((columns[0]?.values || []).map(row => row[1]));
  if (!names.has('state_version')) {
    db.run('ALTER TABLE app_state ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0');
  }

  persistDatabase();

  app.listen(PORT, () => {
    console.log(`Organizaciondaso online en http://localhost:${PORT}`);
    console.log(`Base de datos: ${DB_PATH}`);
  });
}

start().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});

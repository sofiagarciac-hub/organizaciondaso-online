const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'organizaciondaso.sqlite');

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
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function getState() {
  const result = db.exec('SELECT users_json, projects_json FROM app_state WHERE id = 1');
  const values = result[0]?.values?.[0] || ['{}', '{}'];
  return {
    users: parseJSON(values[0], {}),
    projects: parseJSON(values[1], {}),
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

  db.run(
    'UPDATE app_state SET users_json = ?, projects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [JSON.stringify(users), JSON.stringify(projects)]
  );
  persistDatabase();

  res.json({ ok: true });
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
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO app_state (id, users_json, projects_json)
    VALUES (1, '{}', '{}');
  `);
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

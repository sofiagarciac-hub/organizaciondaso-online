const STORAGE_KEY = 'hanter_workspace_multi_v5';
const SESSION_USER_KEY = 'hanter_current_user_v5';
const API_DB_ENDPOINT = '/api/db';
const appRoot = document.getElementById('app');

const state = {
  db: loadDB(),
  entryView: 'landing',
  authMode: 'login',
  startMode: 'create',
  mainTab: 'tickets',
  ticketFilter: 'mine',
  selectedProjectId: localStorage.getItem('hanter_selected_project_v5') || '',
  modal: null,
  notice: '',
  pendingInvite: null,
  search: '',
  editingTaskId: null,
};

function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

function shortCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value + 'T00:00:00');
  return date.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysText(value) {
  if (!value) return 'Sin fecha';
  const now = new Date();
  const date = new Date(value + 'T23:59:59');
  const diff = Math.ceil((date - now) / 86400000);
  if (diff < 0) return 'Vencida';
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  return `${diff} días`;
}

function isLate(task) {
  return task.status !== 'done' && task.dueDate && new Date(task.dueDate + 'T23:59:59') < new Date();
}

function escapeHTML(text = '') {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function initials(name = 'U') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase() || 'U';
}

function loadDB() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const db = JSON.parse(raw);
      db.currentUserId = localStorage.getItem(SESSION_USER_KEY) || db.currentUserId || '';
      return db;
    }
  } catch (err) {}
  return { users: {}, projects: {}, currentUserId: localStorage.getItem(SESSION_USER_KEY) || '' };
}

function saveDB() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db));
  if (state.db.currentUserId) localStorage.setItem(SESSION_USER_KEY, state.db.currentUserId);
  else localStorage.removeItem(SESSION_USER_KEY);
  if (state.selectedProjectId) localStorage.setItem('hanter_selected_project_v5', state.selectedProjectId);
  saveRemoteDB();
}

async function loadRemoteDB() {
  try {
    const response = await fetch(API_DB_ENDPOINT, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error('No se pudo leer la base de datos');
    const remote = await response.json();
    state.db = {
      users: remote.users || {},
      projects: remote.projects || {},
      currentUserId: localStorage.getItem(SESSION_USER_KEY) || state.db.currentUserId || '',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db));
    setSyncStatus(true);
  } catch (err) {
    setSyncStatus(false);
  }
}

async function saveRemoteDB() {
  try {
    const payload = {
      users: state.db.users || {},
      projects: state.db.projects || {},
    };
    const response = await fetch(API_DB_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('No se pudo guardar');
    setSyncStatus(true);
  } catch (err) {
    setSyncStatus(false);
  }
}

async function bootApp() {
  appRoot.innerHTML = '<main class="auth-screen"><section class="auth-card"><h1>Cargando...</h1><p>Conectando con la base de datos.</p></section></main>';
  await loadRemoteDB();
  render();
}

function currentUser() {
  return state.db.users[state.db.currentUserId] || null;
}

function currentProject() {
  const p = state.db.projects[state.selectedProjectId];
  if (!p || !p.members.includes(state.db.currentUserId)) return null;
  return p;
}

function projectsForMe() {
  const me = state.db.currentUserId;
  return Object.values(state.db.projects)
    .filter(p => p.members.includes(me))
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

function touchProject(project) {
  project.updatedAt = new Date().toISOString();
}

function encodePayload(obj) {
  const json = JSON.stringify(obj);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodePayload(text) {
  try {
    let clean = String(text).trim();
    if (clean.includes('#join=')) clean = clean.split('#join=')[1];
    if (clean.includes('join=')) clean = clean.split('join=')[1];
    clean = clean.trim().replace(/^(OD6|HB5)-/i, '');
    clean = clean.split(/[\s&]/)[0];
    clean = clean.replaceAll('-', '+').replaceAll('_', '/');
    while (clean.length % 4) clean += '=';
    return JSON.parse(decodeURIComponent(escape(atob(clean))));
  } catch (err) {
    return null;
  }
}

function invitePayload(project) {
  const safe = JSON.parse(JSON.stringify(project));
  safe.invitedAt = new Date().toISOString();
  return { type: 'organizaciondaso-project-v6', project: safe };
}

function inviteCode(project) {
  return 'OD6-' + encodePayload(invitePayload(project));
}

function inviteLink(project) {
  return `${location.origin}${location.pathname}#join=${encodePayload(invitePayload(project))}`;
}

function importProjectFromPayload(payload, select = true) {
  const me = currentUser();
  if (!payload || !['organizaciondaso-project-v6','hanter-project-v5'].includes(payload.type) || !payload.project || !me) return false;
  const incoming = payload.project;
  const id = incoming.id || uid('project');
  const existing = state.db.projects[id];
  const merged = existing ? mergeProject(existing, incoming) : incoming;
  merged.id = id;
  merged.members = Array.from(new Set([...(merged.members || []), me.id]));
  merged.memberProfiles = merged.memberProfiles || {};
  merged.memberProfiles[me.id] = {
    name: me.name,
    email: me.email,
    role: me.role || 'Integrante',
  };
  state.db.projects[id] = merged;
  touchProject(merged);
  if (select) state.selectedProjectId = id;
  saveDB();
  state.notice = `Te uniste a “${merged.name}”.`;
  return true;
}

function mergeProject(a, b) {
  const merged = { ...a, ...b };
  merged.members = Array.from(new Set([...(a.members || []), ...(b.members || [])]));
  merged.memberProfiles = { ...(a.memberProfiles || {}), ...(b.memberProfiles || {}) };
  merged.tasks = mergeById(a.tasks || [], b.tasks || []);
  merged.agreements = mergeById(a.agreements || [], b.agreements || []);
  merged.meetings = mergeById(a.meetings || [], b.meetings || []);
  return merged;
}

function mergeById(x, y) {
  const map = new Map();
  [...x, ...y].forEach(item => map.set(item.id, { ...(map.get(item.id) || {}), ...item }));
  return [...map.values()];
}

function parseJoinInput(text) {
  const raw = String(text || '').trim();
  const payload = decodePayload(raw);
  if (payload) return { kind: 'payload', payload };
  const codeMatch = raw.toUpperCase().match(/[A-Z0-9]{6}/);
  if (codeMatch) return { kind: 'short', code: codeMatch[0] };
  return null;
}

function showNotice(msg) {
  state.notice = msg;
  render();
  setTimeout(() => {
    if (state.notice === msg) {
      state.notice = '';
      render();
    }
  }, 2400);
}

function setModal(type, data = {}) {
  state.modal = { type, data };
  render();
}

function closeModal() {
  state.modal = null;
  render();
}

const api = {
  showLanding() { state.entryView = 'landing'; render(); },
  showAuth(mode = 'login') { state.entryView = 'auth'; state.authMode = mode; render(); },
  setAuthMode(mode) { state.authMode = mode; render(); },
  setStartMode(mode) { state.startMode = mode; render(); },
  setTab(tab) { state.mainTab = tab; render(); },
  setFilter(filter) { state.ticketFilter = filter; state.search = ''; render(); },
  openModal: setModal,
  closeModal,
  logout() {
    state.db.currentUserId = '';
    state.selectedProjectId = '';
    localStorage.removeItem('hanter_selected_project_v5');
    saveDB();
    render();
  },
  backToProjects() {
    state.selectedProjectId = '';
    localStorage.removeItem('hanter_selected_project_v5');
    saveDB();
    render();
  },
  selectProject(id) {
    if (state.db.projects[id]?.members.includes(state.db.currentUserId)) {
      state.selectedProjectId = id;
      saveDB();
      render();
    }
  },
  copyInvite() {
    const p = currentProject();
    if (!p) return;
    copyText(inviteLink(p));
  },
  copyLongCode() {
    const p = currentProject();
    if (!p) return;
    copyText(inviteCode(p));
  },
  exportProject() {
    const p = currentProject();
    if (!p) return;
    const blob = new Blob([JSON.stringify(invitePayload(p), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_respaldo.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  exportReportPDF() {
    const p = currentProject();
    const me = currentUser();
    if (!p || !me) return;
    const bytes = buildReportPDF(p, me);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_reporte.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
    showNotice('Reporte PDF descargado.');
  },
  deleteProject(id) {
    const p = state.db.projects[id];
    if (!p) return;
    if (!confirm(`¿Eliminar el proyecto “${p.name}” de este navegador?`)) return;
    delete state.db.projects[id];
    if (state.selectedProjectId === id) state.selectedProjectId = '';
    saveDB();
    render();
  },
  updateTaskStatus(taskId, status) {
    const p = currentProject();
    const task = p?.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.status = status;
    if (status === 'done') task.completedAt = todayISO();
    touchProject(p);
    saveDB();
    render();
  },
  deleteTask(taskId) {
    const p = currentProject();
    if (!p) return;
    p.tasks = p.tasks.filter(t => t.id !== taskId);
    touchProject(p);
    saveDB();
    closeModal();
  },
  setSearch(q) { state.search = q; render(); },
  clearDoneTasks() {
    const p = currentProject();
    if (!p) return;
    const count = p.tasks.filter(t => t.status === 'done').length;
    if (!count) return showNotice('No hay tareas completadas para eliminar.');
    if (!confirm(`¿Eliminar las ${count} tareas completadas?`)) return;
    p.tasks = p.tasks.filter(t => t.status !== 'done');
    touchProject(p);
    saveDB();
    showNotice(`${count} tareas eliminadas.`);
  },
  editTask(taskId) {
    state.editingTaskId = taskId;
    setModal('editTask', { id: taskId });
  },
  saveEditTask(taskId, data, assignedToMany) {
    const p = currentProject();
    const task = p?.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.title = data.title.trim();
    task.description = data.description.trim();
    task.dueDate = data.dueDate;
    task.priority = data.priority;
    task.status = data.status;
    task.tags = (data.tags || '').trim();
    task.link = (data.link || '').trim();
    task.assignedToMany = assignedToMany.length ? assignedToMany : [p.members[0]];
    task.assignedTo = task.assignedToMany[0];
    if (task.status === 'done' && !task.completedAt) task.completedAt = todayISO();
    touchProject(p);
    saveDB();
    state.editingTaskId = null;
    closeModal();
    showNotice('Tarea actualizada.');
  },
  importJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const payload = JSON.parse(ev.target.result);
          if (importProjectFromPayload(payload, true)) {
            render();
            showNotice('Proyecto importado correctamente.');
          } else {
            showNotice('El archivo no tiene un proyecto válido.');
          }
        } catch { showNotice('No se pudo leer el archivo.'); }
      };
      reader.readAsText(file);
    };
    input.click();
  },
  deleteAgreement(id) {
    const p = currentProject();
    p.agreements = p.agreements.filter(a => a.id !== id);
    touchProject(p);
    saveDB();
    render();
  },
  deleteMeeting(id) {
    const p = currentProject();
    p.meetings = p.meetings.filter(m => m.id !== id);
    touchProject(p);
    saveDB();
    render();
  }
};
window.app = api;

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => showNotice('Copiado al portapapeles.'));
  } else {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showNotice('Copiado al portapapeles.');
  }
}


function cleanPDFText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pdfEscape(text = '') {
  return cleanPDFText(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapPDFText(text, maxChars = 92) {
  const cleaned = cleanPDFText(text || '');
  if (!cleaned) return ['-'];
  const words = cleaned.split(' ');
  const lines = [];
  let line = '';
  words.forEach(word => {
    if ((line + ' ' + word).trim().length > maxChars) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  });
  if (line) lines.push(line);
  return lines;
}

function projectMemberName(project, id) {
  return project.memberProfiles?.[id]?.name || state.db.users[id]?.name || 'Integrante';
}

function statusPDFText(status) {
  if (status === 'done') return 'Completado';
  if (status === 'doing') return 'En proceso';
  return 'Por hacer';
}

function priorityPDFText(priority) {
  if (priority === 'high') return 'Alta';
  if (priority === 'low') return 'Baja';
  return 'Media';
}

function addReportLine(pages, cursor, text = '', opts = {}) {
  const lineHeight = opts.lineHeight || 14;
  if (!pages.length) pages.push([]);
  if (cursor.y < 58) {
    pages.push([]);
    cursor.y = 780;
  }
  pages[pages.length - 1].push({
    text: cleanPDFText(text),
    x: opts.x || 50,
    y: cursor.y,
    size: opts.size || 10,
    bold: !!opts.bold,
  });
  cursor.y -= lineHeight;
}

function addReportSection(pages, cursor, title) {
  cursor.y -= 8;
  addReportLine(pages, cursor, title.toUpperCase(), { size: 14, bold: true, lineHeight: 20 });
}

function addWrappedReport(pages, cursor, text, opts = {}) {
  const maxChars = opts.maxChars || 92;
  wrapPDFText(text, maxChars).forEach(line => addReportLine(pages, cursor, line, opts));
}

function buildReportPDF(project, me) {
  const pages = [[]];
  const cursor = { y: 780 };
  const tasks = project.tasks || [];
  const done = tasks.filter(t => t.status === 'done');
  const pending = tasks.filter(t => t.status !== 'done');
  const late = tasks.filter(isLate);
  const doing = tasks.filter(t => t.status === 'doing');
  const today = new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });

  addReportLine(pages, cursor, 'Organizaciondaso - Reporte del proyecto', { size: 18, bold: true, lineHeight: 24 });
  addReportLine(pages, cursor, project.name, { size: 16, bold: true, lineHeight: 20 });
  addWrappedReport(pages, cursor, project.description || 'Sin descripcion del proyecto.', { maxChars: 96, lineHeight: 14 });
  addReportLine(pages, cursor, `Generado por: ${me.name} | Fecha: ${today}`, { size: 10, lineHeight: 18 });

  addReportSection(pages, cursor, 'Resumen');
  addReportLine(pages, cursor, `Integrantes: ${(project.members || []).length}`);
  addReportLine(pages, cursor, `Tareas totales: ${tasks.length}`);
  addReportLine(pages, cursor, `Completadas: ${done.length} | En proceso: ${doing.length} | Pendientes: ${pending.length} | Vencidas: ${late.length}`);
  addReportLine(pages, cursor, `Acuerdos registrados: ${(project.agreements || []).length} | Reuniones registradas: ${(project.meetings || []).length}`);

  addReportSection(pages, cursor, 'Equipo');
  (project.members || []).forEach((id, index) => {
    const profile = project.memberProfiles?.[id] || state.db.users[id] || { name: 'Integrante', role: 'Sin rol' };
    const progress = memberProgress(project, id);
    addWrappedReport(pages, cursor, `${index + 1}. ${profile.name} - ${profile.role || 'Integrante'} - ${progress.done}/${progress.total} tareas completadas (${progress.percent}%).`, { maxChars: 100 });
  });

  addReportSection(pages, cursor, 'Tareas completadas');
  if (!done.length) addReportLine(pages, cursor, 'No hay tareas completadas.');
  done.forEach((task, index) => {
    addWrappedReport(pages, cursor, `${index + 1}. ${task.title} | Asignado a: ${assigneeLabel(project, task)} | Completado: ${fmtDate(task.completedAt || task.dueDate)} | Prioridad: ${priorityPDFText(task.priority)}${task.tags ? ' | Tags: ' + task.tags : ''}`, { maxChars: 100 });
    if (task.description) addWrappedReport(pages, cursor, `   Detalle: ${task.description}`, { maxChars: 96, x: 62 });
  });

  addReportSection(pages, cursor, 'Tareas pendientes y en proceso');
  if (!pending.length) addReportLine(pages, cursor, 'No hay tareas pendientes.');
  pending.forEach((task, index) => {
    addWrappedReport(pages, cursor, `${index + 1}. ${task.title} | Estado: ${statusPDFText(task.status)} | Asignado a: ${assigneeLabel(project, task)} | Vence: ${fmtDate(task.dueDate)} | Prioridad: ${priorityPDFText(task.priority)}${isLate(task) ? ' | VENCIDA' : ''}`, { maxChars: 100 });
    if (task.description) addWrappedReport(pages, cursor, `   Detalle: ${task.description}`, { maxChars: 96, x: 62 });
  });

  addReportSection(pages, cursor, 'Acuerdos');
  if (!(project.agreements || []).length) addReportLine(pages, cursor, 'No hay acuerdos registrados.');
  (project.agreements || []).forEach((agreement, index) => {
    addWrappedReport(pages, cursor, `${index + 1}. ${agreement.title} | Responsable: ${projectMemberName(project, agreement.responsible)} | Fecha: ${fmtDate(agreement.date)}`, { maxChars: 100 });
    if (agreement.details) addWrappedReport(pages, cursor, `   Detalle: ${agreement.details}`, { maxChars: 96, x: 62 });
  });

  addReportSection(pages, cursor, 'Reuniones');
  if (!(project.meetings || []).length) addReportLine(pages, cursor, 'No hay reuniones registradas.');
  (project.meetings || []).forEach((meeting, index) => {
    addWrappedReport(pages, cursor, `${index + 1}. ${meeting.title} | Fecha: ${fmtDate(meeting.date)} | Participantes: ${meeting.participants || 'Sin participantes'}`, { maxChars: 100 });
    if (meeting.agenda) addWrappedReport(pages, cursor, `   Agenda: ${meeting.agenda}`, { maxChars: 96, x: 62 });
    if (meeting.minutes) addWrappedReport(pages, cursor, `   Acta: ${meeting.minutes}`, { maxChars: 96, x: 62 });
  });

  return createSimplePDF(pages);
}

function createSimplePDF(pages) {
  const objects = [];
  const pageObjectIds = [];
  const contentObjectIds = [];

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  let nextId = 5;
  pages.forEach((lines, pageIndex) => {
    const contentId = nextId++;
    const pageId = nextId++;
    contentObjectIds.push(contentId);
    pageObjectIds.push(pageId);
    const stream = lines.map(line => {
      const font = line.bold ? 'F2' : 'F1';
      return `BT /${font} ${line.size} Tf ${line.x} ${line.y} Td (${pdfEscape(line.text)}) Tj ET`;
    }).join('\n');
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
  });

  objects[2] = `<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 255;
  return bytes;
}

function bootstrapInvite() {
  if (location.hash.startsWith('#join=')) {
    state.pendingInvite = decodePayload(location.hash);
  }
}
bootstrapInvite();

function render() {
  const me = currentUser();
  if (!me) {
    if (state.pendingInvite) state.entryView = 'auth';
    appRoot.innerHTML = state.entryView === 'auth' ? renderAuth() : renderLanding();
    if (state.entryView === 'auth') bindAuthForms();
    return;
  }
  if (state.pendingInvite) {
    importProjectFromPayload(state.pendingInvite, true);
    state.pendingInvite = null;
    history.replaceState(null, '', location.pathname);
  }
  const project = currentProject();
  if (!project) {
    state.selectedProjectId = '';
    appRoot.innerHTML = renderStart();
    bindStartFormsWithSync();
    return;
  }
  appRoot.innerHTML = renderWorkspace(project, me) + renderModal(project, me);
  bindWorkspaceFormsWithSync(project, me);
}

function renderNotice() {
  if (!state.notice) return '';
  return `<div class="toast">${escapeHTML(state.notice)}</div>`;
}

function renderBrand(extra = '') {
  return `
    <div class="auth-brand ${extra}">
      <div class="brand-logo">OD</div>
      <div class="brand-name"><strong>Organizaciondaso</strong><span>Workspace</span></div>
    </div>`;
}

function renderLanding() {
  return `
    <main class="landing">
      ${renderNotice()}
      <nav class="landing-nav">
        ${renderBrand('landing-brand')}
        <div class="landing-links">
          <a href="#inicio">Inicio</a>
          <a href="#gestion">Gestion</a>
          <a href="#online">Online</a>
        </div>
        <button class="secondary" onclick="app.showAuth('login')">Ingresar</button>
      </nav>

      <section class="landing-page hero-page" id="inicio">
        <div class="hero-bg" aria-hidden="true"></div>
        <div class="hero-overlay"></div>
        <div class="hero-content">
          <span class="eyebrow">Workspace para equipos academicos y proyectos reales</span>
          <h1>Organiza tareas, acuerdos y avances sin perder el control.</h1>
          <p>Una plataforma online para crear proyectos, asignar responsables, controlar fechas, registrar reuniones y revisar el progreso de todo el equipo.</p>
          <div class="hero-actions">
            <button class="primary" onclick="app.showAuth('register')">Crear mi espacio</button>
            <a class="hero-link" href="#gestion">Ver funciones</a>
          </div>
          <div class="hero-metrics">
            <div><strong>3</strong><span>vistas clave</span></div>
            <div><strong>24/7</strong><span>datos online</span></div>
            <div><strong>PDF</strong><span>reportes listos</span></div>
          </div>
        </div>
      </section>

      <section class="landing-page feature-page" id="gestion">
        <div class="section-kicker">Gestion completa</div>
        <div class="section-head">
          <h2>Todo lo que un grupo necesita para avanzar ordenado.</h2>
          <p>Organizaciondaso convierte el trabajo disperso en un flujo claro: tickets, miembros, acuerdos, reuniones y estadisticas en una sola interfaz.</p>
        </div>
        <div class="feature-showcase">
          <article class="feature-panel main-feature">
            <span>01</span>
            <h3>Tablero de tickets</h3>
            <p>Clasifica tareas por estado, prioridad, fecha limite y responsable. Ideal para saber que falta, quien lo hace y que ya se termino.</p>
          </article>
          <article class="feature-panel">
            <span>02</span>
            <h3>Equipo visible</h3>
            <p>Perfiles, roles y carga de trabajo para que nadie quede fuera del seguimiento.</p>
          </article>
          <article class="feature-panel">
            <span>03</span>
            <h3>Acuerdos y reuniones</h3>
            <p>Registra decisiones, responsables y actas para que el proyecto tenga memoria.</p>
          </article>
          <article class="feature-panel">
            <span>04</span>
            <h3>Reportes</h3>
            <p>Exporta informacion del proyecto y revisa metricas de cumplimiento.</p>
          </article>
        </div>
      </section>

      <section class="landing-page online-page" id="online">
        <div class="online-copy">
          <div class="section-kicker">Lista para publicar</div>
          <h2>Base de datos online y despliegue preparado para Render.</h2>
          <p>La aplicacion ya incluye servidor Node, API, SQLite y configuracion render.yaml. Solo falta subir el repositorio a GitHub y conectarlo como Web Service.</p>
          <div class="deploy-steps">
            <div><b>1</b><span>Subir a GitHub</span></div>
            <div><b>2</b><span>Elegir Web Service en Render</span></div>
            <div><b>3</b><span>Agregar disco persistente</span></div>
          </div>
          <button class="primary" onclick="app.showAuth('register')">Empezar ahora</button>
        </div>
        <div class="online-card">
          <div class="status-line"><span class="sync-dot"></span> Online-ready</div>
          <h3>Stack incluido</h3>
          <ul>
            <li>Frontend HTML/CSS/JS</li>
            <li>Servidor Node + Express</li>
            <li>Base SQLite persistente</li>
            <li>Blueprint Render</li>
          </ul>
        </div>
      </section>
    </main>`;
}

function renderAuth() {
  const pending = state.pendingInvite?.project?.name;
  return `
    <main class="auth-screen">
      ${renderNotice()}
      <section class="auth-hero">
        ${renderBrand()}
        <h1>Gestiona proyectos de equipo con claridad.</h1>
        <p>Un workspace online para tareas, responsables, reuniones, acuerdos y seguimiento del avance en un solo lugar.</p>
        <div class="auth-feature-grid">
          <div class="auth-feature"><b>Proyectos compartidos</b><span>Cada equipo trabaja en su propio espacio guardado en la base online.</span></div>
          <div class="auth-feature"><b>Invitaciones</b><span>Comparte enlaces o codigos para unir nuevos integrantes.</span></div>
          <div class="auth-feature"><b>Tablero de tickets</b><span>Organiza tareas por estado, prioridad, fecha y responsable.</span></div>
          <div class="auth-feature"><b>Reportes</b><span>Exporta informacion del proyecto y revisa metricas del equipo.</span></div>
        </div>
      </section>
      <section class="auth-card">
        <button class="ghost auth-back" onclick="app.showLanding()">Volver</button>
        <h2>${state.authMode === 'login' ? 'Iniciar sesion' : 'Crear cuenta'}</h2>
        <p>${pending ? `Tienes una invitacion pendiente a "${escapeHTML(pending)}". Ingresa para unirte.` : 'Accede a tus proyectos y manten el equipo sincronizado.'}</p>
        <div class="switch-row">
          <button class="${state.authMode === 'login' ? 'active' : ''}" onclick="app.setAuthMode('login')">Ingresar</button>
          <button class="${state.authMode === 'register' ? 'active' : ''}" onclick="app.setAuthMode('register')">Registrarme</button>
        </div>
        ${state.authMode === 'login' ? `
          <form id="loginForm" class="form">
            <label>Email<input name="email" type="email" placeholder="tu@email.com" required></label>
            <label>Contrasena<input name="password" type="password" placeholder="Contrasena" required></label>
            <button class="primary full" type="submit">Entrar</button>
            <p class="mini-note">La sesion se guarda en este navegador y los datos del equipo se guardan en la base online.</p>
          </form>` : `
          <form id="registerForm" class="form">
            <label>Nombre completo<input name="name" placeholder="Ej. Sofia Garcia" required></label>
            <label>Email<input name="email" type="email" placeholder="tu@email.com" required></label>
            <label>Rol por defecto<input name="role" placeholder="Ej. Coordinadora, investigadora, disenadora" required></label>
            <label>Contrasena<input name="password" type="password" placeholder="Contrasena" required></label>
            <button class="primary full" type="submit">Crear cuenta</button>
          </form>`}
      </section>
    </main>`;
}

function bindAuthForms() {
  const login = document.getElementById('loginForm');
  const register = document.getElementById('registerForm');
  if (login) login.addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(login));
    const user = Object.values(state.db.users).find(u => u.email.toLowerCase() === data.email.toLowerCase());
    if (!user || user.password !== data.password) return showNotice('Email o contraseña incorrectos.');
    state.db.currentUserId = user.id;
    saveDB();
    render();
  });
  if (register) register.addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(register));
    const exists = Object.values(state.db.users).some(u => u.email.toLowerCase() === data.email.toLowerCase());
    if (exists) return showNotice('Ese email ya está registrado.');
    const id = uid('user');
    state.db.users[id] = { id, name: data.name.trim(), email: data.email.trim(), role: data.role.trim(), password: data.password, createdAt: new Date().toISOString() };
    state.db.currentUserId = id;
    saveDB();
    render();
  });
}

function renderStart() {
  const me = currentUser();
  const list = projectsForMe();
  const localCodes = Object.values(state.db.projects).map(p => p.code).filter(Boolean);
  return `
    <main class="workspace-start">
      ${renderNotice()}
      <div class="start-top">
        ${renderBrand()}
        <button class="ghost" onclick="app.logout()">Salir</button>
      </div>
      <section class="start-card">
        <h1>Hola, ${escapeHTML(me.name.split(' ')[0])}</h1>
        <p>Crea un proyecto nuevo o únete a uno existente. El nombre lo decide quien crea el proyecto; Organizaciondaso solo es la interfaz de organización.</p>
        <div class="tabs">
          <button class="${state.startMode === 'create' ? 'active' : ''}" onclick="app.setStartMode('create')">Crear proyecto</button>
          <button class="${state.startMode === 'join' ? 'active' : ''}" onclick="app.setStartMode('join')">Unirme con enlace/código</button>
          <button class="${state.startMode === 'import' ? 'active' : ''}" onclick="app.setStartMode('import')">Importar respaldo</button>
        </div>
        ${state.startMode === 'import' ? `
          <div class="form">
            <p style="color:var(--muted);font-size:13px;line-height:1.6">Sube el archivo JSON que exportaste antes para recuperar un proyecto en este navegador.</p>
            <button class="primary" onclick="app.importJSON()">📂 Seleccionar archivo JSON</button>
          </div>` : state.startMode === 'create' ? `
          <form id="createProjectForm" class="form">
            <label>Nombre del proyecto<input name="name" placeholder="Ej. Tesis biosensor, App panadería, Trabajo de biología" required></label>
            <label>Descripción breve<textarea name="description" placeholder="¿Para qué servirá este proyecto?"></textarea></label>
            <label>Tu rol en este proyecto<input name="role" value="${escapeHTML(me.role || 'Integrante')}" required></label>
            <button class="primary" type="submit">Crear workspace</button>
          </form>` : `
          <form id="joinProjectForm" class="form">
            <label>Pega enlace de invitación, código largo o código corto<textarea name="invite" placeholder="Pega aquí el enlace de unión o código" required></textarea></label>
            <button class="primary" type="submit">Unirme al proyecto</button>
            <div class="alert info">El código corto solo funciona si ese proyecto ya existe en este navegador. El enlace de invitación o código largo sí trae el proyecto para importarlo.</div>
            ${localCodes.length ? `<p class="mini-note">Códigos cortos cargados aquí: ${localCodes.map(escapeHTML).join(', ')}</p>` : ''}
          </form>`}
        <h2 class="mt-title">Mis proyectos</h2>
        <div class="project-list">
          ${list.length ? list.map(p => renderProjectMini(p)).join('') : `<div class="empty-col">Todavía no tienes proyectos</div>`}
        </div>
      </section>
    </main>`;
}

function renderProjectMini(project) {
  const done = (project.tasks || []).filter(t => t.status === 'done').length;
  const total = (project.tasks || []).length;
  const members = (project.members || []).length;
  return `
    <article class="project-mini">
      <div>
        <strong>${escapeHTML(project.name)}</strong>
        <span>${members} integrantes · ${done}/${total} tareas completadas · Código local: ${escapeHTML(project.code)}</span>
      </div>
      <div class="action-row">
        <button class="secondary" onclick="app.selectProject('${project.id}')">Abrir</button>
        <button class="danger" onclick="app.deleteProject('${project.id}')">Eliminar</button>
      </div>
    </article>`;
}

function bindStartForms() {
  const create = document.getElementById('createProjectForm');
  const join = document.getElementById('joinProjectForm');
  if (create) create.addEventListener('submit', e => {
    e.preventDefault();
    const me = currentUser();
    const data = Object.fromEntries(new FormData(create));
    const id = uid('project');
    const project = {
      id,
      name: data.name.trim(),
      description: data.description.trim(),
      code: shortCode(),
      createdBy: me.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      members: [me.id],
      memberProfiles: { [me.id]: { name: me.name, email: me.email, role: data.role.trim() } },
      tasks: [],
      agreements: [],
      meetings: []
    };
    state.db.projects[id] = project;
    state.selectedProjectId = id;
    saveDB();
    render();
  });
  if (join) join.addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(join));
    const parsed = parseJoinInput(data.invite);
    if (!parsed) return showNotice('No pude leer ese enlace o código.');
    if (parsed.kind === 'payload') {
      if (importProjectFromPayload(parsed.payload, true)) return render();
      return showNotice('El enlace no tiene un proyecto válido.');
    }
    const project = Object.values(state.db.projects).find(p => p.code === parsed.code);
    if (!project) return showNotice('Ese código corto no existe en este navegador. Usa el enlace de invitación.');
    const me = currentUser();
    project.members = Array.from(new Set([...(project.members || []), me.id]));
    project.memberProfiles = project.memberProfiles || {};
    project.memberProfiles[me.id] = { name: me.name, email: me.email, role: me.role || 'Integrante' };
    state.selectedProjectId = project.id;
    touchProject(project);
    saveDB();
    render();
  });
}

function renderWorkspace(project, me) {
  return `
    <div class="app-shell">
      ${renderNotice()}
      <header class="topbar">
        <div class="top-left">
          ${renderBrand()}
          <div class="brand-divider"></div>
          <nav class="main-tabs">
            ${tabBtn('tickets', 'Tickets')}
            ${tabBtn('team', 'Equipo')}
            ${tabBtn('stats', 'Estadísticas')}
            ${tabBtn('org', 'Organización')}
          </nav>
        </div>
        <div class="top-actions">
          <button class="icon-only" title="Copiar invitación" onclick="app.copyInvite()">🔗</button>
          <button class="icon-only" title="Código largo" onclick="app.copyLongCode()">⌁</button>
          <button class="icon-only" title="Exportar respaldo" onclick="app.exportProject()">⬇</button>
          <button class="icon-only" title="Descargar reporte PDF" onclick="app.exportReportPDF()">📄</button>
          <span class="education-pill">${escapeHTML(project.name)}</span>
          <button class="icon-only" title="Salir" onclick="app.logout()">↪</button>
        </div>
      </header>
      <div class="workspace-grid">
        <aside class="sidebar">
          <div class="profile-box">
            <div class="profile-avatar">${escapeHTML(initials(me.name))}<span class="profile-edit">✎</span></div>
            <h2>${escapeHTML(me.name)}</h2>
            <p>${escapeHTML(project.memberProfiles[me.id]?.role || me.role || 'Integrante')}</p>
            ${(() => { const s = taskStats(project,me); const pct = s.total ? Math.round(s.done/s.total*100) : 0; return `<div class="project-progress"><div class="project-progress-bar"><span style="width:${pct}%"></span></div><small>${pct}%</small></div>`; })()}
          </div>
          <nav class="side-nav">
            ${sideBtnBadge('mine', '◴', 'Mis Pendientes', taskStats(project,me).minePending)}
            ${sideBtnBadge('all', '▦', 'Todas', (project.tasks||[]).length)}
            ${sideBtn('created', '▣', 'Creadas por mí')}
            ${sideBtnBadge('done', '◎', 'Completadas', taskStats(project,me).done)}
          </nav>
          <div class="sidebar-tools">
            <div class="sync-info"><span class="sync-dot off" id="syncDot"></span><span id="syncLabel">Solo local</span></div>
            <button onclick="app.backToProjects()">← Cambiar proyecto</button>
            <button onclick="app.copyInvite()">🔗 Copiar enlace unión</button>
            <button onclick="app.exportReportPDF()">📄 Descargar reporte PDF</button>
            <button onclick="app.openModal('projectInfo')">ⓘ Datos del proyecto</button>
          </div>
        </aside>
        <main class="main-content">
          ${renderCurrentTab(project, me)}
        </main>
      </div>
    </div>`;
}

function tabBtn(tab, label) {
  return `<button class="${state.mainTab === tab ? 'active' : ''}" onclick="app.setTab('${tab}')">${label}</button>`;
}

function sideBtn(filter, icon, label) {
  return `<button class="${state.ticketFilter === filter ? 'active' : ''}" onclick="app.setFilter('${filter}'); app.setTab('tickets')"><span class="side-icon">${icon}</span>${label}</button>`;
}
function sideBtnBadge(filter, icon, label, count) {
  return `<button class="${state.ticketFilter === filter ? 'active' : ''}" onclick="app.setFilter('${filter}'); app.setTab('tickets')"><span class="side-icon">${icon}</span>${label}${count > 0 ? `<span class="side-badge">${count}</span>` : ''}</button>`;
}

function renderCurrentTab(project, me) {
  if (state.mainTab === 'team') return renderTeam(project, me);
  if (state.mainTab === 'stats') return renderStats(project, me);
  if (state.mainTab === 'org') return renderOrganization(project, me);
  return renderTickets(project, me);
}

function taskStats(project, me) {
  const tasks = project.tasks || [];
  return {
    total: tasks.length,
    minePending: tasks.filter(t => taskHasAssignee(t, me.id) && t.status !== 'done').length,
    pending: tasks.filter(t => t.status !== 'done').length,
    done: tasks.filter(t => t.status === 'done').length,
    late: tasks.filter(isLate).length,
  };
}

function filteredTasks(project, me) {
  let tasks = project.tasks || [];
  if (state.ticketFilter === 'mine') tasks = tasks.filter(t => taskHasAssignee(t, me.id) && t.status !== 'done');
  else if (state.ticketFilter === 'created') tasks = tasks.filter(t => t.createdBy === me.id);
  else if (state.ticketFilter === 'done') tasks = tasks.filter(t => t.status === 'done');
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    tasks = tasks.filter(t =>
      t.title?.toLowerCase().includes(q) ||
      t.description?.toLowerCase().includes(q) ||
      t.tags?.toLowerCase().includes(q) ||
      assigneeLabel(project, t).toLowerCase().includes(q)
    );
  }
  return tasks;
}

function renderTickets(project, me) {
  const stats = taskStats(project, me);
  const tasks = filteredTasks(project, me);
  const todo = tasks.filter(t => t.status === 'todo');
  const doing = tasks.filter(t => t.status === 'doing');
  const done = tasks.filter(t => t.status === 'done');
  return `
    <div class="content-head">
      <div class="content-title"><h1>${escapeHTML(project.name)}</h1><p>${escapeHTML(project.description || 'Organizaciondaso: espacio de organización grupal')}</p></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="search-input" type="search" placeholder="Buscar tarea..." value="${escapeHTML(state.search)}" oninput="app.setSearch(this.value)" style="width:190px">
        <button class="ghost" onclick="app.clearDoneTasks()" title="Vaciar completadas">🗑 Limpiar</button>
        <button class="primary" onclick="app.openModal('task')">＋ Nueva tarea</button>
      </div>
    </div>
    <section class="stats-row">
      ${renderStat('blue', stats.minePending, 'Mis Pendientes', 'TAREAS SIN COMPLETAR', stats.total ? stats.minePending / Math.max(stats.total,1) * 100 : 8, '◴')}
      ${renderStat('green', stats.done, 'Completadas', 'TAREAS FINALIZADAS', stats.total ? stats.done / Math.max(stats.total,1) * 100 : 0, '✓')}
      ${renderStat('red', stats.late, 'Vencidas', 'REQUIEREN ATENCIÓN', stats.total ? stats.late / Math.max(stats.total,1) * 100 : 0, '!')}
    </section>
    <section class="board">
      ${renderColumn('Por Hacer', 'neutral', todo)}
      ${renderColumn('En Proceso', 'blue', doing)}
      ${renderColumn('Completado', 'green', done)}
    </section>`;
}

function renderStat(type, number, caption, label, progress, icon) {
  const cls = type === 'green' ? 'green' : type === 'red' ? 'red' : '';
  return `
    <article class="stat-card ${cls}">
      <div class="stat-bg"></div>
      <div class="stat-label">${label}</div>
      <div class="stat-icon">${icon}</div>
      <div class="stat-number">${number}</div>
      <div class="stat-caption">${caption}</div>
      <div class="stat-progress"><span style="width:${Math.min(100, Math.max(6, progress))}%"></span></div>
    </article>`;
}

function renderColumn(title, color, tasks) {
  const dot = color === 'blue' ? 'blue' : color === 'green' ? 'green' : '';
  return `
    <div class="column">
      <div class="column-head"><span class="column-title"><span class="dot ${dot}"></span>${title}</span><span class="count-pill ${dot}">${tasks.length}</span></div>
      <div class="ticket-list">${tasks.length ? tasks.map(renderTaskCard).join('') : `<div class="empty-col">Sin tareas en esta columna</div>`}</div>
    </div>`;
}

function renderTaskCard(task) {
  const p = currentProject();
  const member = assigneeLabel(p, task);
  const priority = task.priority || 'medium';
  const priorityText = priority === 'high' ? 'Alta' : priority === 'low' ? 'Baja' : 'Media';
  const late = isLate(task);
  const link = task.link ? `<a class="link-line" href="${escapeHTML(task.link)}" target="_blank"><span>↗</span>${escapeHTML(task.link)}</a>` : '';
  return `
    <article class="ticket-card ${priority}">
      <button class="view-btn" onclick="app.openModal('taskDetail',{id:'${task.id}'})">Ver ›</button>
      <div class="ticket-id">#${escapeHTML(task.id.slice(-8).toUpperCase())} <span class="badge ${priority}">${priorityText}</span> ${late ? '<span class="badge late">Vencida</span>' : ''}</div>
      <h3 class="ticket-title">${escapeHTML(task.title)}</h3>
      <p class="ticket-desc">${escapeHTML(task.description || 'Sin descripción')}</p>
      ${link}
      <div class="ticket-meta"><span class="tiny-avatar">${escapeHTML(initials(member))}</span><b>${escapeHTML(member)}</b><span>📅 ${late ? 'Venció: ' : 'Vence: '}${escapeHTML(fmtDate(task.dueDate))}</span></div>
      ${task.tags ? `<div class="tag-row">${task.tags.split(',').map(x => x.trim()).filter(Boolean).slice(0,4).map(x => `<span class="tag-chip">#${escapeHTML(x)}</span>`).join('')}</div>` : ''}
      <div class="ticket-actions">
        ${task.status === 'todo' ? `<button class="secondary" onclick="app.updateTaskStatus('${task.id}','doing')">Iniciar tarea</button>` : ''}
        ${task.status !== 'done' ? `<button class="success" onclick="app.updateTaskStatus('${task.id}','done')">✓ Marcar realizado</button>` : `<span class="badge done">Completado el ${escapeHTML(fmtDate(task.completedAt || todayISO()))}</span>`}
      </div>
    </article>`;
}

function renderTeam(project, me) {
  const members = project.members || [];
  return `
    <div class="content-head">
      <div class="content-title"><h1>Equipo</h1><p>Integrantes del proyecto “${escapeHTML(project.name)}”.</p></div>
      <button class="primary" onclick="app.copyInvite()">＋ Invitar integrante</button>
    </div>
    <section class="team-grid">
      ${members.map(id => renderMemberCard(project, id, me)).join('')}
    </section>`;
}

function memberProgress(project, id) {
  const tasks = (project.tasks || []).filter(t => taskHasAssignee(t, id));
  const done = tasks.filter(t => t.status === 'done').length;
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  return { total: tasks.length, done, percent };
}

function renderMemberCard(project, id, me) {
  const profile = project.memberProfiles?.[id] || state.db.users[id] || { name: 'Integrante', role: 'Sin rol' };
  const score = memberProgress(project, id);
  return `
    <article class="member-card ${id === me.id ? 'me' : ''}">
      <div class="member-big-avatar">${escapeHTML(initials(profile.name))}</div>
      <h3>${escapeHTML(profile.name)}</h3>
      <span class="role-pill">${escapeHTML(profile.role || 'Integrante')}</span>
      <div class="member-score">
        <div class="score-row"><span>CUMPLIMIENTO</span><strong>${score.percent}%</strong></div>
        <div class="mini-bar"><span style="width:${score.percent}%"></span></div>
        <small>${score.done} completadas de ${score.total} recibidas</small>
      </div>
      <button class="primary assign-btn" onclick="app.openModal('task',{assignedTo:'${id}'})">＋ Asignar tarea</button>
    </article>`;
}

function renderStats(project, me) {
  const members = (project.members || []).map(id => {
    const profile = project.memberProfiles?.[id] || state.db.users[id] || { name: 'Integrante', role: 'Sin rol' };
    const score = memberProgress(project, id);
    const late = (project.tasks || []).filter(t => taskHasAssignee(t, id) && isLate(t)).length;
    return { id, profile, points: score.done - late, done: score.done, late };
  }).sort((a, b) => b.points - a.points);
  const deadlines = [...(project.tasks || [])]
    .filter(t => t.status !== 'done' && t.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 8);
  const avg = members.length ? ((project.tasks || []).filter(t => t.status === 'done').length / Math.max(1, project.tasks.length) * 10).toFixed(1) : '0.0';
  return `
    <div class="content-head">
      <div class="content-title"><h1>Estadísticas</h1><p>Ranking, fechas límite y avance general.</p></div>
    </div>
    <section class="stats-layout">
      <div>
        <div class="podium">
          ${[members[1], members[0], members[2]].map((m, i) => m ? renderPodium(m, i === 1 ? 'first' : '') : `<div class="podium-card"><div class="podium-name">Sin datos</div></div>`).join('')}
        </div>
        <div class="leaderboard">
          <div class="section-banner">TABLA DE POSICIONES</div>
          ${members.length ? members.map((m, i) => renderRank(m, i)).join('') : `<div class="empty-col">Sin integrantes</div>`}
        </div>
      </div>
      <div>
        <div class="deadline-card">
          <div class="section-banner">📅 PRÓXIMAS FECHAS LÍMITE</div>
          ${deadlines.length ? deadlines.map(t => renderDeadline(project, t)).join('') : `<div class="empty-col">No hay fechas pendientes</div>`}
        </div>
        <div class="bottom-metrics">
          <div class="metric-card"><div class="metric-icon">▥</div><div><strong>${avg}</strong><span>Promedio general</span></div></div>
          <div class="metric-card"><div class="metric-icon">♛</div><div><strong>${escapeHTML(members[0]?.profile.name?.split(' ')[0] || '—')}</strong><span>Líder actual</span></div></div>
        </div>
      </div>
    </section>`;
}

function renderPodium(m, cls) {
  return `<div class="podium-card ${cls}"><div class="podium-rank">${cls ? '👑' : '🏅'}</div><div class="podium-avatar">${escapeHTML(initials(m.profile.name))}</div><div class="podium-name">${escapeHTML(m.profile.name.split(' ')[0])}</div><div class="podium-points">${m.points} pts</div></div>`;
}

function renderRank(m, index) {
  return `<div class="rank-row"><div class="rank-number">#${index + 1}</div><span class="tiny-avatar">${escapeHTML(initials(m.profile.name))}</span><div class="rank-main"><strong>${escapeHTML(m.profile.name)}</strong><span>${escapeHTML(m.profile.role || 'Integrante')}</span></div><span class="rank-points">${m.points >= 0 ? '+' : ''}${m.points}</span></div>`;
}

function renderDeadline(project, task) {
  const owner = assigneeLabel(project, task);
  const d = new Date(task.dueDate + 'T00:00:00');
  const cls = isLate(task) ? 'late' : daysText(task.dueDate) === 'Hoy' ? 'today' : '';
  return `<div class="deadline-row"><div class="date-box ${cls}"><span>${String(d.getDate()).padStart(2, '0')}</span><small>${d.toLocaleDateString('es-PE', { month: 'short' }).replace('.', '').toUpperCase()}</small></div><div class="deadline-main"><strong>${escapeHTML(task.title)}</strong><span>${escapeHTML(owner)} · ${escapeHTML(daysText(task.dueDate))}</span></div></div>`;
}

function renderOrganization(project, me) {
  return `
    <div class="content-head">
      <div class="content-title"><h1>Organización</h1><p>Acuerdos y reuniones del proyecto.</p></div>
      <div class="action-row"><button class="primary" onclick="app.openModal('agreement')">＋ Nuevo acuerdo</button><button class="secondary" onclick="app.openModal('meeting')">＋ Nueva reunión</button></div>
    </div>
    <section class="stats-layout">
      <div class="mini-section">
        <div class="section-banner">ACUERDOS</div>
        <div class="mini-content compact-list">
          ${project.agreements?.length ? project.agreements.map(a => renderAgreement(project, a)).join('') : `<div class="empty-col">Aún no hay acuerdos</div>`}
        </div>
      </div>
      <div class="mini-section">
        <div class="section-banner">REUNIONES</div>
        <div class="mini-content compact-list">
          ${project.meetings?.length ? project.meetings.map(m => renderMeeting(m)).join('') : `<div class="empty-col">Aún no hay reuniones</div>`}
        </div>
      </div>
    </section>`;
}

function renderAgreement(project, agreement) {
  const owner = project.memberProfiles?.[agreement.responsible]?.name || 'General';
  return `<div class="compact-item"><strong>${escapeHTML(agreement.title)}</strong><span>${escapeHTML(agreement.details || '')}</span><div class="ticket-meta mt-2"><b>${escapeHTML(owner)}</b><span>${escapeHTML(fmtDate(agreement.date))}</span><button class="danger" onclick="app.deleteAgreement('${agreement.id}')">Eliminar</button></div></div>`;
}

function renderMeeting(meeting) {
  return `<div class="compact-item"><strong>${escapeHTML(meeting.title)}</strong><span>${escapeHTML(meeting.agenda || '')}</span><div class="ticket-meta mt-2"><b>${escapeHTML(fmtDate(meeting.date))}</b><span>${escapeHTML(meeting.participants || 'Sin participantes')}</span><button class="danger" onclick="app.deleteMeeting('${meeting.id}')">Eliminar</button></div></div>`;
}

function optionsMembers(project, selected = '') {
  return (project.members || []).map(id => {
    const p = project.memberProfiles?.[id] || state.db.users[id];
    return `<option value="${id}" ${id === selected ? 'selected' : ''}>${escapeHTML(p?.name || 'Integrante')}</option>`;
  }).join('');
}

function assigneeIds(task) {
  const ids = Array.isArray(task.assignedToMany) && task.assignedToMany.length ? task.assignedToMany : (task.assignedTo ? [task.assignedTo] : []);
  return Array.from(new Set(ids.filter(Boolean)));
}

function taskHasAssignee(task, userId) {
  return assigneeIds(task).includes(userId);
}

function assigneeNames(project, task) {
  const ids = assigneeIds(task);
  if (!ids.length) return ['Sin asignar'];
  return ids.map(id => project.memberProfiles?.[id]?.name || state.db.users[id]?.name || 'Integrante');
}

function assigneeLabel(project, task) {
  const names = assigneeNames(project, task);
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function renderAssigneeChoices(project, selectedIds = []) {
  const chosen = new Set(selectedIds.filter(Boolean));
  return `<div class="assignee-grid">${(project.members || []).map(id => {
    const p = project.memberProfiles?.[id] || state.db.users[id] || { name: 'Integrante', role: '' };
    return `<label class="assignee-option"><input type="checkbox" name="assignedTo" value="${id}" ${chosen.has(id) ? 'checked' : ''}><span class="tiny-avatar">${escapeHTML(initials(p.name))}</span><span><b>${escapeHTML(p.name)}</b><small>${escapeHTML(p.role || 'Integrante')}</small></span></label>`;
  }).join('')}</div>`;
}

function renderModal(project, me) {
  if (!state.modal) return '';
  const { type, data } = state.modal;
  if (type === 'task') return modalShell('Crear Ticket', `
    <form id="taskForm" class="form compact-form">
      <label>Título<input name="title" placeholder="Ej. Revisar marco teórico" required></label>
      <label>Descripción<textarea name="description" placeholder="Detalles de la tarea"></textarea></label>
      <label>Asignar a uno o varios integrantes ${renderAssigneeChoices(project, [data.assignedTo || me.id])}</label>
      <div class="form-two">
        <label>Fecha límite<input name="dueDate" type="date" value="${todayISO()}" required></label>
        <label>Prioridad<select name="priority"><option value="high">Alta</option><option value="medium" selected>Media</option><option value="low">Baja</option></select></label>
      </div>
      <div class="form-two">
        <label>Estado<select name="status"><option value="todo">Por hacer</option><option value="doing">En proceso</option><option value="done">Completado</option></select></label>
        <label>Etiquetas opcionales<input name="tags" placeholder="Ej. tesis, urgente, diseño"></label>
      </div>
      <label>Link opcional<input name="link" placeholder="Google Drive, Canva, documento, etc."></label>
      <button class="primary" type="submit">Guardar tarea</button>
    </form>`, 'Asigna y define los detalles de la tarea');
  if (type === 'taskDetail') {
    const task = project.tasks.find(t => t.id === data.id);
    if (!task) return '';
    const owner = assigneeLabel(project, task);
    return modalShell(task.title, `
      <div class="detail-box">${escapeHTML(task.description || 'Sin descripción')}</div>
      ${task.link ? `<p><a class="link-line" href="${escapeHTML(task.link)}" target="_blank">↗ ${escapeHTML(task.link)}</a></p>` : ''}
      <div class="action-row">
        <span class="badge neutral">Asignado a ${escapeHTML(owner)}</span>${task.tags ? `<span class="badge neutral">${escapeHTML(task.tags)}</span>` : ''}
        <span class="badge neutral">Vence ${escapeHTML(fmtDate(task.dueDate))}</span>
        <span class="badge ${task.priority}">${task.priority === 'high' ? 'Alta' : task.priority === 'low' ? 'Baja' : 'Media'}</span>
      </div>
      <div class="action-row">
        <button class="secondary" onclick="app.updateTaskStatus('${task.id}','todo'); app.closeModal()">Por hacer</button>
        <button class="secondary" onclick="app.updateTaskStatus('${task.id}','doing'); app.closeModal()">En proceso</button>
        <button class="success" onclick="app.updateTaskStatus('${task.id}','done'); app.closeModal()">Completado</button>
        <button class="ghost" onclick="app.editTask('${task.id}')">✏ Editar</button>
        <button class="danger" onclick="app.deleteTask('${task.id}')">Eliminar</button>
      </div>`);
  }
  if (type === 'agreement') return modalShell('Nuevo acuerdo', `
    <form id="agreementForm" class="form">
      <label>Acuerdo<input name="title" placeholder="Ej. Usaremos metodología mixta" required></label>
      <label>Detalle<textarea name="details" placeholder="Explica el acuerdo"></textarea></label>
      <div class="form-two"><label>Responsable<select name="responsible">${optionsMembers(project, me.id)}</select></label><label>Fecha<input name="date" type="date" value="${todayISO()}"></label></div>
      <button class="primary" type="submit">Guardar acuerdo</button>
    </form>`);
  if (type === 'meeting') return modalShell('Nueva reunión', `
    <form id="meetingForm" class="form">
      <label>Título<input name="title" placeholder="Ej. Reunión de avance" required></label>
      <label>Fecha<input name="date" type="date" value="${todayISO()}" required></label>
      <label>Participantes<input name="participants" placeholder="Ej. Sofía, Luis, Ana"></label>
      <label>Agenda<textarea name="agenda" placeholder="Temas a conversar"></textarea></label>
      <label>Acta / conclusiones<textarea name="minutes" placeholder="Acuerdos de la reunión"></textarea></label>
      <button class="primary" type="submit">Guardar reunión</button>
    </form>`);
  if (type === 'editTask') {
    const task = project.tasks.find(t => t.id === data.id);
    if (!task) return '';
    return modalShell('Editar Tarea', `
    <form id="editTaskForm" class="form">
      <label>Título<input name="title" value="${escapeHTML(task.title)}" required></label>
      <label>Descripción<textarea name="description">${escapeHTML(task.description || '')}</textarea></label>
      <label>Asignar a ${renderAssigneeChoices(project, assigneeIds(task))}</label>
      <div class="form-two">
        <label>Fecha límite<input name="dueDate" type="date" value="${task.dueDate || todayISO()}" required></label>
        <label>Prioridad<select name="priority"><option value="high" ${task.priority==='high'?'selected':''}>Alta</option><option value="medium" ${task.priority==='medium'?'selected':''}>Media</option><option value="low" ${task.priority==='low'?'selected':''}>Baja</option></select></label>
      </div>
      <div class="form-two">
        <label>Estado<select name="status"><option value="todo" ${task.status==='todo'?'selected':''}>Por hacer</option><option value="doing" ${task.status==='doing'?'selected':''}>En proceso</option><option value="done" ${task.status==='done'?'selected':''}>Completado</option></select></label>
        <label>Etiquetas<input name="tags" value="${escapeHTML(task.tags||'')}" placeholder="tesis, urgente..."></label>
      </div>
      <label>Link<input name="link" value="${escapeHTML(task.link||'')}" placeholder="Google Drive, Canva..."></label>
      <button class="primary" type="submit">Guardar cambios</button>
    </form>`, 'Modifica los detalles de la tarea');
  }
  if (type === 'projectInfo') return modalShell('Datos del proyecto', `
    <div class="detail-box"><b>Nombre:</b> ${escapeHTML(project.name)}\n<b>Código corto local:</b> ${escapeHTML(project.code)}\n<b>Integrantes:</b> ${(project.members || []).length}\n\nEl enlace de unión lleva una copia del proyecto para poder importarlo en otro navegador.</div>
    <div class="action-row"><button class="primary" onclick="app.copyInvite()">Copiar enlace unión</button><button class="secondary" onclick="app.copyLongCode()">Copiar código largo</button><button class="ghost" onclick="app.exportProject()">Exportar respaldo</button><button class="ghost" onclick="app.exportReportPDF()">Descargar reporte PDF</button></div>`);
  return '';
}

function modalShell(title, body, subtitle = '') {
  return `<div class="modal-bg"><section class="modal"><div class="modal-head"><div class="modal-head-inner"><div><h2>${escapeHTML(title)}</h2>${subtitle ? `<p>${escapeHTML(subtitle)}</p>` : ''}</div><button class="close-x" onclick="app.closeModal()">×</button></div></div><div class="modal-body">${body}</div></section></div>`;
}

function bindWorkspaceForms(project, me) {
  const editTaskForm = document.getElementById('editTaskForm');
  if (editTaskForm) editTaskForm.addEventListener('submit', e => {
    e.preventDefault();
    const formData = new FormData(editTaskForm);
    const data = Object.fromEntries(formData);
    const assignedToMany = formData.getAll('assignedTo').filter(Boolean);
    app.saveEditTask(state.editingTaskId || state.modal?.data?.id, data, assignedToMany);
  });
  const taskForm = document.getElementById('taskForm');
  if (taskForm) taskForm.addEventListener('submit', e => {
    e.preventDefault();
    const formData = new FormData(taskForm);
    const data = Object.fromEntries(formData);
    const assignedToMany = formData.getAll('assignedTo').filter(Boolean);
    if (!assignedToMany.length) assignedToMany.push(me.id);
    project.tasks.push({
      id: uid('task'),
      title: data.title.trim(),
      description: data.description.trim(),
      assignedTo: assignedToMany[0],
      assignedToMany,
      dueDate: data.dueDate,
      priority: data.priority,
      status: data.status,
      tags: (data.tags || '').trim(),
      link: data.link.trim(),
      createdBy: me.id,
      createdAt: new Date().toISOString(),
      completedAt: data.status === 'done' ? todayISO() : ''
    });
    touchProject(project);
    saveDB();
    closeModal();
  });
  const agreementForm = document.getElementById('agreementForm');
  if (agreementForm) agreementForm.addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(agreementForm));
    project.agreements.push({ id: uid('agreement'), title: data.title.trim(), details: data.details.trim(), responsible: data.responsible, date: data.date || todayISO(), createdBy: me.id });
    touchProject(project);
    saveDB();
    closeModal();
  });
  const meetingForm = document.getElementById('meetingForm');
  if (meetingForm) meetingForm.addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(meetingForm));
    project.meetings.push({ id: uid('meeting'), title: data.title.trim(), date: data.date, participants: data.participants.trim(), agenda: data.agenda.trim(), minutes: data.minutes.trim(), createdBy: me.id });
    touchProject(project);
    saveDB();
    closeModal();
  });
}

function setSyncStatus(online) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if (dot) dot.className = 'sync-dot' + (online ? '' : ' off');
  if (label) label.textContent = online ? 'Online' : 'Sin conexión';
}

function bindStartFormsWithSync() {
  bindStartForms();
}

function bindWorkspaceFormsWithSync(project, me) {
  bindWorkspaceForms(project, me);
  setSyncStatus(true);
}

bootApp();

const STORAGE_KEY = 'hanter_workspace_multi_v5';
const SESSION_USER_KEY = 'hanter_current_user_v5';
const API_DB_ENDPOINT = '/api/db';
const appRoot = document.getElementById('app');

const state = {
  db: loadDB(),
  entryView: 'landing',
  authMode: 'login',
  startMode: 'create',
  mainTab: 'today',
  ticketFilter: 'mine',
  priorityFilter: 'all',
  dueFilter: 'all',
  theme: localStorage.getItem('hanter_theme_v5') || 'light',
  selectedProjectId: localStorage.getItem('hanter_selected_project_v5') || '',
  modal: null,
  notice: '',
  pendingInvite: null,
  search: '',
  editingTaskId: null,
  agentMessages: [],
  serverVersion: null,
  sync: { status: 'offline', label: 'Solo local' },
};

let remoteSaveQueue = Promise.resolve();

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
  queueRemoteSave();
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
    state.serverVersion = Number.isFinite(Number(remote.version)) ? Number(remote.version) : null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db));
    setSyncStatus('online', 'Online');
  } catch (err) {
    setSyncStatus('offline', 'Sin conexión');
  }
}

function queueRemoteSave() {
  setSyncStatus('saving', 'Guardando...');
  remoteSaveQueue = remoteSaveQueue
    .catch(() => {})
    .then(() => saveRemoteDB());
  return remoteSaveQueue;
}

async function saveRemoteDB(retryOnConflict = true) {
  try {
    const payload = {
      users: state.db.users || {},
      projects: state.db.projects || {},
      version: state.serverVersion,
    };
    const response = await fetch(API_DB_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 409) {
      const conflict = await response.json();
      if (retryOnConflict && mergeRemoteState(conflict.state)) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db));
        return saveRemoteDB(false);
      }
      throw new Error('Conflicto de sincronización');
    }
    if (!response.ok) throw new Error('No se pudo guardar');
    const saved = await response.json();
    state.serverVersion = Number.isFinite(Number(saved.version)) ? Number(saved.version) : state.serverVersion;
    setSyncStatus('online', 'Guardado');
  } catch (err) {
    setSyncStatus('offline', 'Sin conexión');
  }
}

function mergeRemoteState(remote) {
  if (!remote || typeof remote !== 'object') return false;
  const localCurrentUser = state.db.currentUserId;
  const localUsers = state.db.users || {};
  const localProjects = state.db.projects || {};
  const mergedProjects = { ...(remote.projects || {}) };

  Object.entries(localProjects).forEach(([id, localProject]) => {
    const remoteProject = mergedProjects[id];
    mergedProjects[id] = remoteProject ? mergeProject(remoteProject, localProject) : localProject;
    mergedProjects[id].updatedAt = [remoteProject?.updatedAt, localProject?.updatedAt]
      .filter(Boolean)
      .sort()
      .at(-1) || new Date().toISOString();
  });

  state.db = {
    users: { ...(remote.users || {}), ...localUsers },
    projects: mergedProjects,
    currentUserId: localCurrentUser,
  };
  state.serverVersion = Number.isFinite(Number(remote.version)) ? Number(remote.version) : state.serverVersion;
  setSyncStatus('saving', 'Fusionando cambios...');
  return true;
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

function applyTheme() {
  document.body.classList.toggle('dark-theme', state.theme === 'dark');
}

function canManageProject(project, userId) {
  if (!project || !userId) return false;
  return project.createdBy ? project.createdBy === userId : project.members?.[0] === userId;
}

function canManageTask(project, task, userId) {
  return task?.createdBy === userId || canManageProject(project, userId);
}

function checklistProgress(task) {
  const checklist = task.checklist || [];
  const done = checklist.filter(item => item.done).length;
  return { total: checklist.length, done };
}

function taskMetaSummary(task) {
  const progress = checklistProgress(task);
  const comments = (task.comments || []).length;
  const parts = [];
  if (progress.total) parts.push(`${progress.done}/${progress.total} subtareas`);
  if (comments) parts.push(`${comments} comentario${comments === 1 ? '' : 's'}`);
  return parts.join(' | ');
}

function isTodayISO(value) {
  return value === todayISO();
}

function isThisWeekISO(value) {
  return inCurrentWeek(value);
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
  setPriorityFilter(filter) { state.priorityFilter = filter; render(); },
  setDueFilter(filter) { state.dueFilter = filter; render(); },
  toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('hanter_theme_v5', state.theme);
    render();
  },
  openModal: setModal,
  openProfileEditor() { setModal('profile'); },
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
  copyWeeklySummary() {
    const p = currentProject();
    const me = currentUser();
    if (!p || !me) return;
    copyText(weeklyText(p, me));
  },
  askSofia(text) {
    const p = currentProject();
    const me = currentUser();
    const query = (text || '').trim();
    if (!p || !me || !query) return;
    state.agentMessages.push({ from: 'me', text: query });
    const result = sofiaAgentReply(p, me, query);
    state.agentMessages.push({ from: 'sofia', text: result.text });
    state.agentMessages = state.agentMessages.slice(-8);
    if (result.openModal) setModal(result.openModal);
    else render();
  },
  openTaskCreator() { setModal('task'); },
  openMeetingCreator() { setModal('meeting'); },
  requestNotifications() {
    if (!('Notification' in window)) return showNotice('Tu navegador no soporta notificaciones.');
    Notification.requestPermission().then(permission => {
      showNotice(permission === 'granted' ? 'Notificaciones activadas.' : 'No se activaron las notificaciones.');
      runReminderCheck(true);
    });
  },
  deleteProject(id) {
    const p = state.db.projects[id];
    if (!p) return;
    if (!canManageProject(p, state.db.currentUserId)) return showNotice('Solo quien creo el proyecto puede eliminarlo.');
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
    const task = p.tasks.find(t => t.id === taskId);
    if (!canManageTask(p, task, state.db.currentUserId)) return showNotice('Solo quien creo la tarea o el proyecto puede eliminarla.');
    p.tasks = p.tasks.filter(t => t.id !== taskId);
    touchProject(p);
    saveDB();
    closeModal();
  },
  setSearch(q) { state.search = q; render(); },
  addSubtask(taskId, title) {
    const p = currentProject();
    const task = p?.tasks.find(t => t.id === taskId);
    const cleanTitle = (title || '').trim();
    if (!task || !cleanTitle) return;
    task.checklist = task.checklist || [];
    task.checklist.push({ id: uid('sub'), title: cleanTitle, done: false, createdAt: new Date().toISOString() });
    touchProject(p);
    saveDB();
    render();
  },
  toggleSubtask(taskId, subtaskId) {
    const p = currentProject();
    const task = p?.tasks.find(t => t.id === taskId);
    const item = task?.checklist?.find(x => x.id === subtaskId);
    if (!item) return;
    item.done = !item.done;
    item.completedAt = item.done ? new Date().toISOString() : '';
    touchProject(p);
    saveDB();
    render();
  },
  deleteSubtask(taskId, subtaskId) {
    const p = currentProject();
    const task = p?.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.checklist = (task.checklist || []).filter(x => x.id !== subtaskId);
    touchProject(p);
    saveDB();
    render();
  },
  addComment(taskId, text) {
    const p = currentProject();
    const me = currentUser();
    const task = p?.tasks.find(t => t.id === taskId);
    const cleanText = (text || '').trim();
    if (!task || !me || !cleanText) return;
    task.comments = task.comments || [];
    task.comments.push({ id: uid('comment'), text: cleanText, authorId: me.id, createdAt: new Date().toISOString() });
    touchProject(p);
    saveDB();
    render();
  },
  deleteComment(taskId, commentId) {
    const p = currentProject();
    const me = currentUser();
    const task = p?.tasks.find(t => t.id === taskId);
    const comment = task?.comments?.find(x => x.id === commentId);
    if (!task || !comment || !me) return;
    if (comment.authorId !== me.id && !canManageTask(p, task, me.id)) return showNotice('Solo puedes borrar tus comentarios o los de tus tareas.');
    task.comments = (task.comments || []).filter(x => x.id !== commentId);
    touchProject(p);
    saveDB();
    render();
  },
  clearDoneTasks() {
    const p = currentProject();
    if (!p) return;
    if (!canManageProject(p, state.db.currentUserId)) return showNotice('Solo quien creo el proyecto puede limpiar completadas.');
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
  },
  saveProfile(data) {
    const me = currentUser();
    const p = currentProject();
    if (!me || !p) return;
    const clean = {
      name: (data.name || me.name).trim(),
      email: (data.email || me.email).trim(),
      role: (data.role || me.role || 'Integrante').trim(),
      avatarUrl: (data.avatarUrl || '').trim(),
      profileUrl: (data.profileUrl || '').trim(),
      bio: (data.bio || '').trim(),
    };
    state.db.users[me.id] = { ...me, ...clean };
    Object.values(state.db.projects || {}).forEach(project => {
      if (!project.members?.includes(me.id)) return;
      project.memberProfiles = project.memberProfiles || {};
      project.memberProfiles[me.id] = { ...(project.memberProfiles[me.id] || {}), ...clean };
      touchProject(project);
    });
    saveDB();
    closeModal();
    showNotice('Perfil actualizado.');
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

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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

function projectMemberProfile(project, id) {
  return {
    ...(state.db.users[id] || {}),
    ...(project.memberProfiles?.[id] || {}),
  };
}

function avatarMarkup(profile = {}, className = 'tiny-avatar') {
  const name = profile.name || 'Integrante';
  if (profile.avatarUrl) {
    return `<span class="${className} avatar-img"><img src="${escapeHTML(profile.avatarUrl)}" alt="${escapeHTML(name)}" onerror="this.parentElement.classList.remove('avatar-img');this.remove();"></span>`;
  }
  return `<span class="${className}">${escapeHTML(initials(name))}</span>`;
}

function weekRange(date = new Date()) {
  const start = new Date(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function inCurrentWeek(value) {
  if (!value) return false;
  const { start, end } = weekRange();
  const date = new Date(value.length === 10 ? value + 'T12:00:00' : value);
  return date >= start && date <= end;
}

function weekLabel() {
  const { start, end } = weekRange();
  return `${fmtDate(start.toISOString().slice(0, 10))} - ${fmtDate(end.toISOString().slice(0, 10))}`;
}

function weeklySummary(project, me) {
  const tasks = project.tasks || [];
  const doneWeek = tasks.filter(t => t.status === 'done' && inCurrentWeek(t.completedAt || t.updatedAt || t.dueDate));
  const createdWeek = tasks.filter(t => inCurrentWeek(t.createdAt || t.dueDate));
  const dueWeek = tasks.filter(t => t.status !== 'done' && inCurrentWeek(t.dueDate));
  const late = tasks.filter(isLate);
  const score = memberProgress(project, me.id);
  const members = (project.members || []).map(id => {
    const profile = projectMemberProfile(project, id);
    const progress = memberProgress(project, id);
    return { id, name: profile.name || 'Integrante', progress };
  }).sort((a, b) => b.progress.percent - a.progress.percent || b.progress.done - a.progress.done);
  return {
    range: weekLabel(),
    total: tasks.length,
    done: tasks.filter(t => t.status === 'done').length,
    doing: tasks.filter(t => t.status === 'doing').length,
    todo: tasks.filter(t => t.status === 'todo').length,
    late: late.length,
    dueWeek,
    doneWeek,
    createdWeek,
    personalPercent: score.percent,
    leader: members[0],
  };
}

function sofiaInsights(project, me) {
  const s = weeklySummary(project, me);
  const tasks = project.tasks || [];
  const highOpen = tasks.filter(t => t.status !== 'done' && t.priority === 'high');
  const withoutAssignee = tasks.filter(t => !assigneeIds(t).length);
  const doing = tasks.filter(t => t.status === 'doing');
  const ideas = [];

  if (!tasks.length) {
    ideas.push({
      title: 'Empieza con 3 tareas pequenas',
      text: 'Crea una tarea de investigacion, una de entrega y una de revision. Asi el tablero ya muestra avance real esta semana.',
      tone: 'blue',
    });
  }
  if (s.late) {
    ideas.push({
      title: 'Hay tareas vencidas',
      text: `Sofia recomienda revisar ${s.late} tarea(s) vencida(s), cambiar fecha o moverlas a completado si ya se hicieron.`,
      tone: 'red',
    });
  }
  if (highOpen.length) {
    ideas.push({
      title: 'Prioridad alta primero',
      text: `Tienes ${highOpen.length} tarea(s) de prioridad alta abiertas. Conviene asignar responsable y resolverlas antes de agregar mas trabajo.`,
      tone: 'orange',
    });
  }
  if (doing.length > 4) {
    ideas.push({
      title: 'Demasiado en proceso',
      text: 'El tablero tiene muchas tareas en proceso. Cierra o divide las mas grandes para que el avance se vea claro.',
      tone: 'orange',
    });
  }
  if (withoutAssignee.length) {
    ideas.push({
      title: 'Faltan responsables',
      text: `${withoutAssignee.length} tarea(s) no tienen integrante asignado. Asignarlas ayuda a que el reporte semanal sea mas justo.`,
      tone: 'blue',
    });
  }
  if (!s.dueWeek.length && tasks.some(t => t.status !== 'done')) {
    ideas.push({
      title: 'Agenda la semana',
      text: 'No hay entregas pendientes para esta semana. Pon fechas cercanas para que Sofia pueda priorizar mejor.',
      tone: 'green',
    });
  }
  if (s.doneWeek.length) {
    ideas.push({
      title: 'Buen cierre semanal',
      text: `Esta semana ya se completaron ${s.doneWeek.length} tarea(s). Incluyelas en el PDF para mostrar evidencia de avance.`,
      tone: 'green',
    });
  }

  return ideas.slice(0, 5);
}

function weeklyText(project, me) {
  const s = weeklySummary(project, me);
  const ideas = sofiaInsights(project, me).map(i => `- ${i.title}: ${i.text}`).join('\n');
  return `Reporte semanal ${project.name}
Semana: ${s.range}
Avance: ${s.done}/${s.total} tareas completadas. En proceso: ${s.doing}. Pendientes: ${s.todo}. Vencidas: ${s.late}.
Mi avance: ${s.personalPercent}%.
Sugerencias de Sofia:
${ideas || '- Crear tareas, responsables y fechas para medir avance.'}`;
}

function nextPendingTasks(project, limit = 5) {
  return [...(project.tasks || [])]
    .filter(t => t.status !== 'done')
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))
    .slice(0, limit);
}

function upcomingMeetings(project, limit = 5) {
  const today = todayISO();
  return [...(project.meetings || [])]
    .filter(m => !m.date || m.date >= today)
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))
    .slice(0, limit);
}

function sofiaAgentReply(project, me, query) {
  const q = query.toLowerCase();
  const tasks = project.tasks || [];
  const meetings = project.meetings || [];
  const pending = nextPendingTasks(project, 6);
  const late = tasks.filter(isLate);

  if (q.includes('crear') && q.includes('tarea')) {
    return { text: 'Te abro el formulario de tarea. Pon titulo, responsable, fecha y prioridad para que aparezca en el tablero y en el reporte.', openModal: 'task' };
  }
  if (q.includes('agenda') || q.includes('agendar') || q.includes('reunion') || q.includes('reunión')) {
    const upcoming = upcomingMeetings(project, 3);
    const list = upcoming.length ? upcoming.map(m => `- ${m.title} (${fmtDate(m.date)})`).join('\n') : 'No hay reuniones futuras registradas.';
    return { text: `Te abro el formulario para agendar una reunion.\n\nReuniones proximas:\n${list}`, openModal: 'meeting' };
  }
  if (q.includes('vence') || q.includes('vencen') || q.includes('fecha') || q.includes('pendiente')) {
    const list = pending.length ? pending.map(t => `- ${t.title}: ${fmtDate(t.dueDate)} (${daysText(t.dueDate)}) - ${assigneeLabel(project, t)}`).join('\n') : 'No hay tareas pendientes.';
    return { text: `Tareas pendientes por fecha:\n${list}` };
  }
  if (q.includes('tarea')) {
    const done = tasks.filter(t => t.status === 'done').length;
    const doing = tasks.filter(t => t.status === 'doing').length;
    const todo = tasks.filter(t => t.status === 'todo').length;
    const list = pending.length ? pending.slice(0, 4).map(t => `- ${t.title} (${statusPDFText(t.status)}, ${assigneeLabel(project, t)})`).join('\n') : 'No hay tareas abiertas.';
    return { text: `Resumen de tareas: ${done} completadas, ${doing} en proceso, ${todo} por hacer y ${late.length} vencidas.\n\nProximas:\n${list}` };
  }
  if (q.includes('quien') || q.includes('equipo') || q.includes('avance') || q.includes('responsable')) {
    const rows = (project.members || []).map(id => {
      const profile = projectMemberProfile(project, id);
      const progress = memberProgress(project, id);
      return `- ${profile.name || 'Integrante'}: ${progress.percent}% (${progress.done}/${progress.total})`;
    }).join('\n') || 'Aun no hay integrantes.';
    return { text: `Avance del equipo:\n${rows}` };
  }
  if (q.includes('notifica') || q.includes('avis')) {
    return { text: 'Puedes activar notificaciones con el boton "Activar avisos". Te avisare cuando una tarea o reunion este para hoy, manana o ya vencida.' };
  }

  const insight = sofiaInsights(project, me)[0];
  return { text: insight ? `${insight.title}: ${insight.text}` : 'Puedo responder sobre tareas, vencimientos, reuniones, responsables, avance del equipo y ayudarte a agendar.' };
}

function reminderItems(project) {
  const now = new Date();
  const items = [];
  (project.tasks || []).forEach(task => {
    if (task.status === 'done' || !task.dueDate) return;
    const due = new Date(task.dueDate + 'T23:59:59');
    const days = Math.ceil((due - now) / 86400000);
    if (days < -1 || days > 1) return;
    items.push({
      id: `task-${task.id}-${task.dueDate}`,
      title: days < 0 ? 'Tarea vencida' : days === 0 ? 'Tarea para hoy' : 'Tarea para manana',
      body: `${task.title} - ${assigneeLabel(project, task)}`,
    });
  });
  (project.meetings || []).forEach(meeting => {
    if (!meeting.date) return;
    const date = new Date(meeting.date + 'T12:00:00');
    const days = Math.ceil((date - now) / 86400000);
    if (days < 0 || days > 1) return;
    items.push({
      id: `meeting-${meeting.id}-${meeting.date}`,
      title: days === 0 ? 'Reunion para hoy' : 'Reunion para manana',
      body: `${meeting.title} - ${fmtDate(meeting.date)}`,
    });
  });
  return items;
}

function runReminderCheck(force = false) {
  const project = currentProject();
  if (!project) return;
  const storageKey = `organizaciondaso_notified_${todayISO()}`;
  const sent = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]'));
  const items = reminderItems(project).filter(item => force || !sent.has(item.id));
  if (!items.length) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    items.slice(0, 3).forEach(item => new Notification(item.title, { body: item.body }));
  }
  showNotice(items[0].title + ': ' + items[0].body);
  items.forEach(item => sent.add(item.id));
  localStorage.setItem(storageKey, JSON.stringify([...sent]));
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
  const summary = weeklySummary(project, me);
  const insights = sofiaInsights(project, me);
  const today = new Date().toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });

  addReportLine(pages, cursor, 'Organizaciondaso - Reporte semanal del proyecto', { size: 18, bold: true, lineHeight: 24 });
  addReportLine(pages, cursor, project.name, { size: 16, bold: true, lineHeight: 20 });
  addWrappedReport(pages, cursor, project.description || 'Sin descripcion del proyecto.', { maxChars: 96, lineHeight: 14 });
  addReportLine(pages, cursor, `Semana: ${summary.range} | Generado por: ${me.name} | Fecha: ${today}`, { size: 10, lineHeight: 18 });

  addReportSection(pages, cursor, 'Resumen ejecutivo');
  addReportLine(pages, cursor, `Integrantes: ${(project.members || []).length}`);
  addReportLine(pages, cursor, `Tareas totales: ${tasks.length}`);
  addReportLine(pages, cursor, `Completadas: ${done.length} | En proceso: ${doing.length} | Pendientes: ${pending.length} | Vencidas: ${late.length}`);
  addReportLine(pages, cursor, `Creadas esta semana: ${summary.createdWeek.length} | Cerradas esta semana: ${summary.doneWeek.length} | Vencen esta semana: ${summary.dueWeek.length}`);
  addReportLine(pages, cursor, `Acuerdos registrados: ${(project.agreements || []).length} | Reuniones registradas: ${(project.meetings || []).length}`);

  addReportSection(pages, cursor, 'Sofia - sugerencias');
  if (!insights.length) addReportLine(pages, cursor, 'Sin alertas fuertes. Mantener fechas y responsables actualizados.');
  insights.forEach((item, index) => addWrappedReport(pages, cursor, `${index + 1}. ${item.title}: ${item.text}`, { maxChars: 100 }));

  addReportSection(pages, cursor, 'Equipo');
  (project.members || []).forEach((id, index) => {
    const profile = projectMemberProfile(project, id);
    const progress = memberProgress(project, id);
    addWrappedReport(pages, cursor, `${index + 1}. ${profile.name} - ${profile.role || 'Integrante'} - ${progress.done}/${progress.total} tareas completadas (${progress.percent}%).`, { maxChars: 100 });
  });

  addReportSection(pages, cursor, 'Vencen esta semana');
  if (!summary.dueWeek.length) addReportLine(pages, cursor, 'No hay tareas pendientes con fecha dentro de esta semana.');
  summary.dueWeek.forEach((task, index) => {
    addWrappedReport(pages, cursor, `${index + 1}. ${task.title} | ${statusPDFText(task.status)} | ${assigneeLabel(project, task)} | Vence: ${fmtDate(task.dueDate)} | Prioridad: ${priorityPDFText(task.priority)}`, { maxChars: 100 });
  });

  addReportSection(pages, cursor, 'Tareas completadas');
  if (!done.length) addReportLine(pages, cursor, 'No hay tareas completadas.');
  done.forEach((task, index) => {
    addWrappedReport(pages, cursor, `${index + 1}. ${task.title} | Asignado a: ${assigneeLabel(project, task)} | Completado: ${fmtDate(task.completedAt || task.dueDate)} | Prioridad: ${priorityPDFText(task.priority)}${task.tags ? ' | Tags: ' + task.tags : ''}`, { maxChars: 100 });
    if (task.description) addWrappedReport(pages, cursor, `   Detalle: ${task.description}`, { maxChars: 96, x: 62 });
    if (taskMetaSummary(task)) addWrappedReport(pages, cursor, `   Seguimiento: ${taskMetaSummary(task)}`, { maxChars: 96, x: 62 });
  });

  addReportSection(pages, cursor, 'Tareas pendientes y en proceso');
  if (!pending.length) addReportLine(pages, cursor, 'No hay tareas pendientes.');
  pending.forEach((task, index) => {
    addWrappedReport(pages, cursor, `${index + 1}. ${task.title} | Estado: ${statusPDFText(task.status)} | Asignado a: ${assigneeLabel(project, task)} | Vence: ${fmtDate(task.dueDate)} | Prioridad: ${priorityPDFText(task.priority)}${isLate(task) ? ' | VENCIDA' : ''}`, { maxChars: 100 });
    if (task.description) addWrappedReport(pages, cursor, `   Detalle: ${task.description}`, { maxChars: 96, x: 62 });
    if (taskMetaSummary(task)) addWrappedReport(pages, cursor, `   Seguimiento: ${taskMetaSummary(task)}`, { maxChars: 96, x: 62 });
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
  applyTheme();
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
  runReminderCheck();
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
          <a href="#plataforma">Plataforma</a>
          <a href="#operacion">Operación</a>
          <a href="#seguridad">Confianza</a>
        </div>
        <div class="landing-actions">
          <button class="ghost" onclick="app.showAuth('login')">Ingresar</button>
          <button class="primary" onclick="app.showAuth('register')">Crear workspace</button>
        </div>
      </nav>

      <section class="landing-page hero-page" id="plataforma">
        <div class="hero-bg" aria-hidden="true"></div>
        <div class="hero-overlay"></div>
        <div class="hero-content">
          <span class="eyebrow">Suite online de coordinación y seguimiento</span>
          <h1>Organizaciondaso Online</h1>
          <p>Un workspace profesional para convertir tareas, responsables, reuniones y acuerdos en una operación visible, medible y fácil de presentar.</p>
          <div class="hero-actions">
            <button class="primary hero-cta" onclick="app.showAuth('register')">Empezar gratis</button>
            <button class="secondary hero-cta" onclick="app.showAuth('login')">Entrar al panel</button>
          </div>
          <div class="hero-bullets">
            <span>Tablero Kanban</span>
            <span>Reportes PDF</span>
            <span>Base online</span>
          </div>
        </div>
        <div class="hero-product" aria-label="Vista previa del panel">
          <div class="product-top">
            <span></span><span></span><span></span>
            <strong>Panel ejecutivo</strong>
          </div>
          <div class="product-shell">
            <aside class="product-nav">
              <b>OD</b>
              <span class="active"></span>
              <span></span>
              <span></span>
            </aside>
            <div class="product-main">
              <div class="product-title">
                <div><span>Proyecto</span><strong>Lanzamiento Q3</strong></div>
                <em>Online</em>
              </div>
              <div class="product-grid">
                <div class="product-stat"><span>Avance</span><strong>74%</strong></div>
                <div class="product-stat"><span>Tareas</span><strong>18</strong></div>
                <div class="product-stat danger-soft"><span>Riesgos</span><strong>3</strong></div>
              </div>
              <div class="product-board">
                <div><b>Por hacer</b><span></span><span></span></div>
                <div><b>En proceso</b><span></span><span></span><span></span></div>
                <div><b>Completado</b><span></span><span></span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="landing-page proof-page">
        <div class="proof-copy">
          <span class="section-kicker">Hecho para avanzar</span>
          <h2>Todo el equipo ve lo mismo: prioridades, responsables y progreso.</h2>
        </div>
        <div class="proof-metrics">
          <div><strong>1</strong><span>lugar para tareas y acuerdos</span></div>
          <div><strong>0</strong><span>pendientes perdidos en chats</span></div>
          <div><strong>PDF</strong><span>reportes listos para entregar</span></div>
        </div>
      </section>

      <section class="landing-page feature-page" id="operacion">
        <div class="section-kicker">Operación completa</div>
        <div class="section-head">
          <h2>Un sistema simple para coordinar, medir y cerrar pendientes.</h2>
          <p>Organizaciondaso ayuda a pasar de conversaciones dispersas a un tablero accionable, con responsables visibles, fechas claras y reportes listos para revisar avances.</p>
        </div>
        <div class="company-strip">
          <span>Planificación</span>
          <span>Seguimiento</span>
          <span>Responsables</span>
          <span>Reportes PDF</span>
        </div>
        <div class="feature-showcase enterprise-grid">
          <article class="feature-panel main-feature enterprise-feature">
            <span>01 / CONTROL</span>
            <h3>Tablero operativo</h3>
            <p>Ordena el trabajo por estado, prioridad, fecha límite y responsable para saber qué debe pasar hoy y qué ya quedó cerrado.</p>
          </article>
          <article class="feature-panel">
            <span>02 / EQUIPO</span>
            <h3>Responsabilidad visible</h3>
            <p>Cada integrante tiene rol, perfil y carga de trabajo clara. Menos confusión, más acción.</p>
          </article>
          <article class="feature-panel">
            <span>03 / MEMORIA</span>
            <h3>Acuerdos y reuniones</h3>
            <p>Guarda decisiones, actas y responsables para que el proyecto no dependa de chats perdidos.</p>
          </article>
          <article class="feature-panel">
            <span>04 / DIRECCIÓN</span>
            <h3>Métricas y reportes</h3>
            <p>Revisa avance, cumplimiento y fechas clave. Exporta reportes listos para compartir.</p>
          </article>
          <article class="feature-panel">
            <span>05 / SOPORTE</span>
            <h3>Sofia asistente</h3>
            <p>Resume pendientes, detecta vencimientos y ayuda a preparar la siguiente acción del equipo.</p>
          </article>
        </div>
      </section>

      <section class="landing-page workflow-page">
        <div class="section-head compact-head">
          <h2>De pendiente suelto a entrega cerrada.</h2>
          <p>El flujo está pensado para equipos que necesitan moverse rápido sin perder trazabilidad.</p>
        </div>
        <div class="workflow-grid">
          <article class="workflow-card">
            <b>01</b>
            <h3>Captura el trabajo</h3>
            <p>Crea tareas con prioridad, fecha limite, responsable y enlaces de apoyo.</p>
          </article>
          <article class="workflow-card">
            <b>02</b>
            <h3>Alinea al equipo</h3>
            <p>Invita integrantes, define roles y mantiene visible quien tiene cada pendiente.</p>
          </article>
          <article class="workflow-card">
            <b>03</b>
            <h3>Registra decisiones</h3>
            <p>Guarda acuerdos y reuniones para que el proyecto tenga memoria operativa.</p>
          </article>
          <article class="workflow-card">
            <b>04</b>
            <h3>Entrega con evidencia</h3>
            <p>Revisa metricas, copia resumen semanal y descarga reportes PDF.</p>
          </article>
        </div>
      </section>

      <section class="landing-page online-page" id="seguridad">
        <div class="online-copy">
          <div class="section-kicker">Lista para operar online</div>
          <h2>Base persistente, sincronización y despliegue preparado.</h2>
          <p>La aplicación usa servidor Node, API propia y SQLite persistente. Está preparada para publicarse en Render y mantener la información del equipo disponible.</p>
          <div class="deploy-steps">
            <div><b>01</b><span>Datos guardados en servidor</span></div>
            <div><b>02</b><span>Control de cambios para evitar sobrescrituras</span></div>
            <div><b>03</b><span>Backups automáticos antes de persistir</span></div>
          </div>
          <button class="primary" onclick="app.showAuth('register')">Crear cuenta</button>
        </div>
        <div class="online-card">
          <div class="status-line"><span class="sync-dot online"></span> Operación online</div>
          <h3>Lo que recibe tu equipo</h3>
          <ul>
            <li><b>Panel único</b><span>Tareas, equipo, reuniones y estadísticas.</span></li>
            <li><b>Invitaciones</b><span>Enlaces y códigos para sumar integrantes.</span></li>
            <li><b>Continuidad</b><span>Datos persistentes y respaldo local exportable.</span></li>
            <li><b>Entrega</b><span>Reportes PDF y resumen semanal.</span></li>
          </ul>
        </div>
      </section>

      <section class="landing-page final-cta">
        <span class="section-kicker">Empieza en minutos</span>
        <h2>Menos coordinación manual. Más avance visible.</h2>
        <p>Crea un workspace, invita al equipo y empieza a convertir pendientes dispersos en un plan de trabajo claro.</p>
        <div class="hero-actions">
          <button class="primary hero-cta" onclick="app.showAuth('register')">Crear workspace</button>
          <button class="secondary hero-cta" onclick="app.showAuth('login')">Ya tengo cuenta</button>
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
  const myProfile = projectMemberProfile(project, me.id);
  return `
    <div class="app-shell">
      ${renderNotice()}
      <header class="topbar">
        <div class="top-left">
          ${renderBrand()}
          <div class="brand-divider"></div>
          <nav class="main-tabs">
            ${tabBtn('today', 'Inicio')}
            ${tabBtn('tickets', 'Tareas')}
            ${tabBtn('team', 'Equipo')}
            ${tabBtn('stats', 'Reportes')}
            ${tabBtn('org', 'Organización')}
          </nav>
        </div>
        <div class="top-actions">
          <button class="top-action-btn" onclick="app.copyInvite()">Invitar</button>
          <button class="top-action-btn" onclick="app.exportProject()">Respaldo</button>
          <button class="top-action-btn primary-lite" onclick="app.exportReportPDF()">PDF</button>
          <button class="top-action-btn" onclick="app.toggleTheme()">${state.theme === 'dark' ? 'Claro' : 'Oscuro'}</button>
          <span class="education-pill">${escapeHTML(project.name)}</span>
          <button class="top-action-btn" onclick="app.logout()">Salir</button>
        </div>
      </header>
      <div class="workspace-grid">
        <aside class="sidebar">
          <div class="profile-box">
            <button class="profile-avatar-btn" onclick="app.openProfileEditor()" title="Editar perfil">
              ${avatarMarkup(myProfile, 'profile-avatar')}
              <span class="profile-edit">Editar</span>
            </button>
            <h2>${escapeHTML(myProfile.name || me.name)}</h2>
            <p>${escapeHTML(myProfile.role || me.role || 'Integrante')}</p>
            ${(() => { const s = taskStats(project,me); const pct = s.total ? Math.round(s.done/s.total*100) : 0; return `<div class="project-progress"><div class="project-progress-bar"><span style="width:${pct}%"></span></div><small>${pct}%</small></div>`; })()}
          </div>
          <nav class="side-nav">
            ${sideBtnBadge('mine', '◴', 'Mis Pendientes', taskStats(project,me).minePending)}
            ${sideBtnBadge('all', '▦', 'Todas', (project.tasks||[]).length)}
            ${sideBtn('created', '▣', 'Creadas por mí')}
            ${sideBtnBadge('done', '◎', 'Completadas', taskStats(project,me).done)}
          </nav>
          <div class="sidebar-tools">
            <div class="sync-info"><span class="${syncDotClass()}" id="syncDot"></span><span id="syncLabel">${escapeHTML(state.sync.label)}</span></div>
            <button onclick="app.backToProjects()">← Cambiar proyecto</button>
            <button onclick="app.openProfileEditor()">Editar perfil</button>
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
  if (state.mainTab === 'today') return renderToday(project, me);
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

function renderSofia(project, me) {
  const summary = weeklySummary(project, me);
  const insights = sofiaInsights(project, me);
  const pct = summary.total ? Math.round(summary.done / summary.total * 100) : 0;
  const nextTasks = [...(project.tasks || [])]
    .filter(t => t.status !== 'done')
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))
    .slice(0, 4);
  return `
    <div class="content-head">
      <div class="content-title"><h1>Sofía</h1><p>IA gratis interna: revisa avance, fechas, responsables y prepara el enfoque semanal.</p></div>
      <div class="action-row"><button class="secondary" onclick="app.copyWeeklySummary()">Copiar resumen</button><button class="primary" onclick="app.exportReportPDF()">Descargar PDF semanal</button></div>
    </div>
    <section class="sofia-hero">
      <div>
        <span class="section-kicker">Semana ${escapeHTML(summary.range)}</span>
        <h2>${pct}% de avance general</h2>
        <p>${summary.done} de ${summary.total} tareas completadas. ${summary.late ? `Hay ${summary.late} vencida(s), conviene revisarlas hoy.` : 'Sin vencidas fuertes por ahora.'}</p>
      </div>
      <div class="sofia-meter">
        <strong>${summary.personalPercent}%</strong>
        <span>tu avance</span>
        <div class="mini-bar"><span style="width:${summary.personalPercent}%"></span></div>
      </div>
    </section>
    <section class="sofia-grid">
      <article class="weekly-card">
        <h3>Plan semanal</h3>
        <div class="weekly-stats">
          <div><strong>${summary.createdWeek.length}</strong><span>creadas</span></div>
          <div><strong>${summary.doneWeek.length}</strong><span>cerradas</span></div>
          <div><strong>${summary.dueWeek.length}</strong><span>vencen</span></div>
        </div>
        <p>${summary.leader ? `${escapeHTML(summary.leader.name)} lidera con ${summary.leader.progress.percent}% de cumplimiento.` : 'Agrega integrantes y tareas para ver ranking.'}</p>
      </article>
      <article class="weekly-card">
        <h3>Próximas tareas</h3>
        ${nextTasks.length ? nextTasks.map(t => `<div class="sofia-task"><b>${escapeHTML(t.title)}</b><span>${escapeHTML(assigneeLabel(project, t))} · ${escapeHTML(daysText(t.dueDate))}</span></div>`).join('') : `<div class="empty-col">No hay tareas pendientes</div>`}
      </article>
    </section>
    <section class="suggestion-grid">
      ${insights.length ? insights.map(item => `
        <article class="suggestion-card ${item.tone}">
          <span>Sugerencia de Sofía</span>
          <h3>${escapeHTML(item.title)}</h3>
          <p>${escapeHTML(item.text)}</p>
        </article>`).join('') : `
        <article class="suggestion-card green"><span>Sugerencia de Sofía</span><h3>Todo tranquilo</h3><p>Mantén tareas con responsable y fecha para que el reporte semanal siga claro.</p></article>`}
    </section>`;
}

function renderToday(project, me) {
  const tasks = project.tasks || [];
  const late = tasks.filter(isLate).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
  const today = tasks.filter(t => t.status !== 'done' && isTodayISO(t.dueDate));
  const mine = tasks.filter(t => taskHasAssignee(t, me.id) && t.status !== 'done').slice(0, 6);
  const high = tasks.filter(t => t.status !== 'done' && t.priority === 'high').slice(0, 6);
  const stats = taskStats(project, me);
  const completion = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  const nextDeadlines = tasks
    .filter(t => t.status !== 'done' && t.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 5);
  const meetings = [...(project.meetings || [])].filter(m => m.date && m.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  return `
    <section class="workspace-hero">
      <div>
        <span class="section-kicker">Panel de control</span>
        <h1>${escapeHTML(project.name)}</h1>
        <p>${escapeHTML(project.description || 'Organiza tareas, equipo, reuniones y entregas desde un solo espacio.')}</p>
      </div>
      <div class="workspace-score">
        <strong>${completion}%</strong>
        <span>avance total</span>
        <div class="mini-bar"><span style="width:${completion}%"></span></div>
      </div>
    </section>
    <section class="stats-row compact-stats">
      ${renderStat('blue', stats.minePending, 'Mis pendientes', 'ENFOQUE PERSONAL', stats.total ? stats.minePending / Math.max(stats.total,1) * 100 : 8, '•')}
      ${renderStat('green', stats.done, 'Completadas', 'AVANCE REAL', stats.total ? stats.done / Math.max(stats.total,1) * 100 : 0, '✓')}
      ${renderStat('red', stats.late, 'Vencidas', 'RIESGO', stats.total ? stats.late / Math.max(stats.total,1) * 100 : 0, '!')}
    </section>
    <section class="focus-layout">
      <div class="focus-stack">
        ${renderFocusCard('Para resolver ahora', [...late, ...today].slice(0, 6), project, late.length ? 'red' : 'orange')}
        ${renderFocusCard('Tus tareas activas', mine, project, 'blue')}
      </div>
      <div class="agenda-panel">
        <div class="agenda-head">
          <div><span class="section-kicker">Agenda</span><h2>Próximos movimientos</h2></div>
          <button class="secondary" onclick="app.openModal('task')">Nueva tarea</button>
        </div>
        <div class="agenda-list">
          ${nextDeadlines.length ? nextDeadlines.map(t => renderAgendaTask(project, t)).join('') : `<div class="empty-col compact-empty">No hay fechas pendientes</div>`}
        </div>
        <div class="agenda-head secondary-head">
          <div><span class="section-kicker">Reuniones</span><h2>Calendario del equipo</h2></div>
          <button class="ghost" onclick="app.openModal('meeting')">Nueva reunión</button>
        </div>
        <div class="compact-list">
          ${meetings.length ? meetings.map(m => renderMeeting(m)).join('') : `<div class="empty-col compact-empty">Sin reuniones próximas</div>`}
        </div>
      </div>
    </section>`;
}

function renderAgendaTask(project, task) {
  return `<button class="agenda-task ${isLate(task) ? 'late' : ''}" onclick="app.openModal('taskDetail',{id:'${task.id}'})"><span>${escapeHTML(fmtDate(task.dueDate))}</span><b>${escapeHTML(task.title)}</b><small>${escapeHTML(assigneeLabel(project, task))} | ${escapeHTML(daysText(task.dueDate))}</small></button>`;
}

function renderFocusCard(title, tasks, project, tone) {
  return `
    <article class="focus-card ${tone}">
      <div class="focus-head"><strong>${escapeHTML(title)}</strong><span>${tasks.length}</span></div>
      <div class="focus-list">
        ${tasks.length ? tasks.map(t => `
          <button onclick="app.openModal('taskDetail',{id:'${t.id}'})">
            <b>${escapeHTML(t.title)}</b>
            <small>${escapeHTML(assigneeLabel(project, t))} | ${escapeHTML(daysText(t.dueDate))}</small>
          </button>`).join('') : `<div class="empty-col compact-empty">Sin tareas</div>`}
      </div>
    </article>`;
}

function renderCalendar(project, me) {
  const groups = {};
  (project.tasks || [])
    .filter(t => t.status !== 'done' && t.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .forEach(task => {
      groups[task.dueDate] = groups[task.dueDate] || [];
      groups[task.dueDate].push(task);
    });
  const days = Object.keys(groups);
  return `
    <div class="content-head">
      <div class="content-title"><h1>Calendario</h1><p>Vista gratis por fechas limite, sin integraciones externas.</p></div>
      <button class="primary" onclick="app.openModal('task')">+ Nueva tarea</button>
    </div>
    <section class="calendar-list">
      ${days.length ? days.map(day => `
        <article class="calendar-day ${day === todayISO() ? 'today' : ''}">
          <div class="calendar-date"><strong>${escapeHTML(fmtDate(day))}</strong><span>${groups[day].length} pendiente${groups[day].length === 1 ? '' : 's'}</span></div>
          <div class="calendar-tasks">${groups[day].map(task => renderCalendarTask(project, task)).join('')}</div>
        </article>`).join('') : `<div class="empty-col">No hay tareas con fecha limite</div>`}
    </section>`;
}

function renderCalendarTask(project, task) {
  return `<button class="calendar-task ${task.priority || 'medium'}" onclick="app.openModal('taskDetail',{id:'${task.id}'})"><b>${escapeHTML(task.title)}</b><span>${escapeHTML(assigneeLabel(project, task))} | ${escapeHTML(daysText(task.dueDate))}</span></button>`;
}

function filteredTasks(project, me) {
  let tasks = project.tasks || [];
  if (state.ticketFilter === 'mine') tasks = tasks.filter(t => taskHasAssignee(t, me.id) && t.status !== 'done');
  else if (state.ticketFilter === 'created') tasks = tasks.filter(t => t.createdBy === me.id);
  else if (state.ticketFilter === 'done') tasks = tasks.filter(t => t.status === 'done');
  if (state.priorityFilter !== 'all') tasks = tasks.filter(t => (t.priority || 'medium') === state.priorityFilter);
  if (state.dueFilter === 'late') tasks = tasks.filter(isLate);
  else if (state.dueFilter === 'today') tasks = tasks.filter(t => isTodayISO(t.dueDate));
  else if (state.dueFilter === 'week') tasks = tasks.filter(t => t.status !== 'done' && isThisWeekISO(t.dueDate));
  else if (state.dueFilter === 'no-date') tasks = tasks.filter(t => !t.dueDate);
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    tasks = tasks.filter(t =>
      t.title?.toLowerCase().includes(q) ||
      t.description?.toLowerCase().includes(q) ||
      t.tags?.toLowerCase().includes(q) ||
      assigneeLabel(project, t).toLowerCase().includes(q) ||
      (t.comments || []).some(c => c.text?.toLowerCase().includes(q)) ||
      (t.checklist || []).some(item => item.title?.toLowerCase().includes(q))
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
        <select class="filter-select" onchange="app.setPriorityFilter(this.value)">
          <option value="all" ${state.priorityFilter === 'all' ? 'selected' : ''}>Toda prioridad</option>
          <option value="high" ${state.priorityFilter === 'high' ? 'selected' : ''}>Alta</option>
          <option value="medium" ${state.priorityFilter === 'medium' ? 'selected' : ''}>Media</option>
          <option value="low" ${state.priorityFilter === 'low' ? 'selected' : ''}>Baja</option>
        </select>
        <select class="filter-select" onchange="app.setDueFilter(this.value)">
          <option value="all" ${state.dueFilter === 'all' ? 'selected' : ''}>Todas las fechas</option>
          <option value="late" ${state.dueFilter === 'late' ? 'selected' : ''}>Vencidas</option>
          <option value="today" ${state.dueFilter === 'today' ? 'selected' : ''}>Hoy</option>
          <option value="week" ${state.dueFilter === 'week' ? 'selected' : ''}>Esta semana</option>
          <option value="no-date" ${state.dueFilter === 'no-date' ? 'selected' : ''}>Sin fecha</option>
        </select>
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
  const progress = checklistProgress(task);
  const comments = (task.comments || []).length;
  const link = task.link ? `<a class="link-line" href="${escapeHTML(task.link)}" target="_blank"><span>↗</span>${escapeHTML(task.link)}</a>` : '';
  return `
    <article class="ticket-card ${priority}">
      <button class="view-btn" onclick="app.openModal('taskDetail',{id:'${task.id}'})">Ver ›</button>
      <div class="ticket-id">#${escapeHTML(task.id.slice(-8).toUpperCase())} <span class="badge ${priority}">${priorityText}</span> ${late ? '<span class="badge late">Vencida</span>' : ''}</div>
      <h3 class="ticket-title">${escapeHTML(task.title)}</h3>
      <p class="ticket-desc">${escapeHTML(task.description || 'Sin descripción')}</p>
      ${link}
      <div class="ticket-meta"><span class="tiny-avatar">${escapeHTML(initials(member))}</span><b>${escapeHTML(member)}</b><span>📅 ${late ? 'Venció: ' : 'Vence: '}${escapeHTML(fmtDate(task.dueDate))}</span></div>
      ${(progress.total || comments) ? `<div class="task-mini-metrics">${progress.total ? `<span>${progress.done}/${progress.total} subtareas</span>` : ''}${comments ? `<span>${comments} comentarios</span>` : ''}</div>` : ''}
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
  const profile = projectMemberProfile(project, id);
  const score = memberProgress(project, id);
  return `
    <article class="member-card ${id === me.id ? 'me' : ''}">
      ${avatarMarkup(profile, 'member-big-avatar')}
      <h3>${escapeHTML(profile.name)}</h3>
      <span class="role-pill">${escapeHTML(profile.role || 'Integrante')}</span>
      ${profile.bio ? `<p class="member-bio">${escapeHTML(profile.bio)}</p>` : ''}
      ${profile.profileUrl ? `<a class="member-link" href="${escapeHTML(profile.profileUrl)}" target="_blank" rel="noreferrer">Ver perfil</a>` : ''}
      <div class="member-score">
        <div class="score-row"><span>CUMPLIMIENTO</span><strong>${score.percent}%</strong></div>
        <div class="mini-bar"><span style="width:${score.percent}%"></span></div>
        <small>${score.done} completadas de ${score.total} recibidas</small>
      </div>
      <button class="primary assign-btn" onclick="app.openModal('task',{assignedTo:'${id}'})">＋ Asignar tarea</button>
      ${id === me.id ? `<button class="ghost assign-btn" onclick="app.openProfileEditor()">Editar mi perfil</button>` : ''}
    </article>`;
}

function renderStats(project, me) {
  const members = (project.members || []).map(id => {
    const profile = projectMemberProfile(project, id);
    const score = memberProgress(project, id);
    const late = (project.tasks || []).filter(t => taskHasAssignee(t, id) && isLate(t)).length;
    return { id, profile, points: score.done - late, done: score.done, late };
  }).sort((a, b) => b.points - a.points);
  const deadlines = [...(project.tasks || [])]
    .filter(t => t.status !== 'done' && t.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 8);
  const avg = members.length ? ((project.tasks || []).filter(t => t.status === 'done').length / Math.max(1, project.tasks.length) * 10).toFixed(1) : '0.0';
  const insights = sofiaInsights(project, me).slice(0, 3);
  return `
    <div class="content-head">
      <div class="content-title"><h1>Reportes</h1><p>Avance, riesgos y resumen semanal del proyecto.</p></div>
      <div class="action-row"><button class="secondary" onclick="app.copyWeeklySummary()">Copiar resumen</button><button class="primary" onclick="app.exportReportPDF()">Descargar PDF</button></div>
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
    </section>
    <section class="suggestion-grid report-insights">
      ${insights.length ? insights.map(item => `
        <article class="suggestion-card ${item.tone}">
          <span>Lectura del proyecto</span>
          <h3>${escapeHTML(item.title)}</h3>
          <p>${escapeHTML(item.text)}</p>
        </article>`).join('') : `
        <article class="suggestion-card green"><span>Lectura del proyecto</span><h3>Sin alertas</h3><p>Agrega tareas con responsable y fecha para obtener mejores reportes.</p></article>`}
    </section>`;
}

function renderPodium(m, cls) {
  return `<div class="podium-card ${cls}"><div class="podium-rank">${cls ? '👑' : '🏅'}</div>${avatarMarkup(m.profile, 'podium-avatar')}<div class="podium-name">${escapeHTML(m.profile.name.split(' ')[0])}</div><div class="podium-points">${m.points} pts</div></div>`;
}

function renderRank(m, index) {
  return `<div class="rank-row"><div class="rank-number">#${index + 1}</div>${avatarMarkup(m.profile, 'tiny-avatar')}<div class="rank-main"><strong>${escapeHTML(m.profile.name)}</strong><span>${escapeHTML(m.profile.role || 'Integrante')}</span></div><span class="rank-points">${m.points >= 0 ? '+' : ''}${m.points}</span></div>`;
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
    const p = projectMemberProfile(project, id);
    return `<label class="assignee-option"><input type="checkbox" name="assignedTo" value="${id}" ${chosen.has(id) ? 'checked' : ''}>${avatarMarkup(p, 'tiny-avatar')}<span><b>${escapeHTML(p.name)}</b><small>${escapeHTML(p.role || 'Integrante')}</small></span></label>`;
  }).join('')}</div>`;
}

function renderTaskCollaboration(project, task) {
  const checklist = task.checklist || [];
  const comments = task.comments || [];
  const progress = checklistProgress(task);
  return `
    <section class="task-panel">
      <div class="task-panel-head"><h3>Checklist</h3><span>${progress.done}/${progress.total}</span></div>
      <div class="checklist-list">
        ${checklist.length ? checklist.map(item => `
          <label class="check-item ${item.done ? 'done' : ''}">
            <input type="checkbox" ${item.done ? 'checked' : ''} onchange="app.toggleSubtask('${task.id}','${item.id}')">
            <span>${escapeHTML(item.title)}</span>
            <button type="button" onclick="app.deleteSubtask('${task.id}','${item.id}')">Eliminar</button>
          </label>`).join('') : `<div class="empty-col compact-empty">Sin subtareas</div>`}
      </div>
      <form id="subtaskForm" class="inline-form">
        <input name="title" placeholder="Agregar subtarea..." autocomplete="off">
        <button class="secondary" type="submit">Agregar</button>
      </form>
    </section>
    <section class="task-panel">
      <div class="task-panel-head"><h3>Comentarios</h3><span>${comments.length}</span></div>
      <div class="comment-list">
        ${comments.length ? comments.map(comment => {
          const author = projectMemberName(project, comment.authorId);
          const canDelete = comment.authorId === state.db.currentUserId || canManageTask(project, task, state.db.currentUserId);
          return `<article class="comment-item"><div><b>${escapeHTML(author)}</b><small>${escapeHTML(new Date(comment.createdAt || Date.now()).toLocaleDateString('es-PE'))}</small></div><p>${escapeHTML(comment.text)}</p>${canDelete ? `<button onclick="app.deleteComment('${task.id}','${comment.id}')">Eliminar</button>` : ''}</article>`;
        }).join('') : `<div class="empty-col compact-empty">Sin comentarios</div>`}
      </div>
      <form id="taskCommentForm" class="inline-form">
        <input name="text" placeholder="Escribir comentario..." autocomplete="off">
        <button class="secondary" type="submit">Comentar</button>
      </form>
    </section>`;
}

function renderModal(project, me) {
  if (!state.modal) return '';
  const { type, data } = state.modal;
  if (type === 'profile') {
    const profile = projectMemberProfile(project, me.id);
    return modalShell('Editar perfil', `
      <form id="profileForm" class="form">
        <label>Nombre completo<input name="name" value="${escapeHTML(profile.name || me.name)}" required></label>
        <div class="form-two">
          <label>Email<input name="email" type="email" value="${escapeHTML(profile.email || me.email)}" required></label>
          <label>Rol<input name="role" value="${escapeHTML(profile.role || me.role || 'Integrante')}" required></label>
        </div>
        <input type="hidden" name="avatarUrl" value="${escapeHTML(profile.avatarUrl || '')}">
        <label>Subir foto desde tu compu<input name="avatarFile" type="file" accept="image/*"></label>
        ${profile.avatarUrl ? `<div class="profile-preview">${avatarMarkup(profile, 'member-big-avatar')}<span>Foto actual guardada</span></div>` : `<p class="mini-note">Puedes subir una imagen JPG, PNG o WEBP. Se guarda dentro de tu perfil.</p>`}
        <label>Link personal<input name="profileUrl" value="${escapeHTML(profile.profileUrl || '')}" placeholder="Portafolio, Drive, LinkedIn, etc."></label>
        <label>Bio corta<textarea name="bio" placeholder="Ej. Encargada de investigación y reportes">${escapeHTML(profile.bio || '')}</textarea></label>
        <button class="primary full" type="submit">Guardar perfil</button>
      </form>`, 'Cambia tu foto, rol y datos visibles para el equipo');
  }
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
    const canDeleteTask = canManageTask(project, task, me.id);
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
        ${canDeleteTask ? `<button class="danger" onclick="app.deleteTask('${task.id}')">Eliminar</button>` : ''}
      </div>
      ${renderTaskCollaboration(project, task)}`);
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
  const profileForm = document.getElementById('profileForm');
  if (profileForm) profileForm.addEventListener('submit', async e => {
    e.preventDefault();
    const formData = new FormData(profileForm);
    const data = Object.fromEntries(formData);
    const file = formData.get('avatarFile');
    if (file && file.size) {
      if (!file.type.startsWith('image/')) return showNotice('Sube una imagen valida.');
      if (file.size > 900000) return showNotice('La foto pesa mucho. Usa una imagen menor a 900 KB.');
      data.avatarUrl = await fileToDataURL(file);
    }
    app.saveProfile(data);
  });
  const editTaskForm = document.getElementById('editTaskForm');
  if (editTaskForm) editTaskForm.addEventListener('submit', e => {
    e.preventDefault();
    const formData = new FormData(editTaskForm);
    const data = Object.fromEntries(formData);
    const assignedToMany = formData.getAll('assignedTo').filter(Boolean);
    app.saveEditTask(state.editingTaskId || state.modal?.data?.id, data, assignedToMany);
  });
  const subtaskForm = document.getElementById('subtaskForm');
  if (subtaskForm) subtaskForm.addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(subtaskForm));
    app.addSubtask(state.modal?.data?.id, data.title);
  });
  const taskCommentForm = document.getElementById('taskCommentForm');
  if (taskCommentForm) taskCommentForm.addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(taskCommentForm));
    app.addComment(state.modal?.data?.id, data.text);
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
      checklist: [],
      comments: [],
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

function syncDotClass() {
  return 'sync-dot ' + (state.sync.status || 'offline');
}

function setSyncStatus(status, text) {
  state.sync = { status, label: text };
  const dot = document.getElementById('syncDot');
  const syncLabel = document.getElementById('syncLabel');
  if (dot) dot.className = syncDotClass();
  if (syncLabel) syncLabel.textContent = state.sync.label;
}

function bindStartFormsWithSync() {
  bindStartForms();
}

function bindWorkspaceFormsWithSync(project, me) {
  bindWorkspaceForms(project, me);
  setSyncStatus(state.sync.status, state.sync.label);
}

bootApp();
setInterval(runReminderCheck, 5 * 60 * 1000);

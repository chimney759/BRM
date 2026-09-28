/* Local demo API: Node built-in SQLite, behind the same REST contract as cloud. */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pinyin } = require('pinyin-pro');
const sanitizeHtml = require('sanitize-html');
const { legacyProjectIds, migrateLegacyProjectIds } = require('./scripts/migrate-project-ids');

const host = process.env.BRMS_HOST || '127.0.0.1';
const port = Number(process.env.BRMS_API_PORT || 3000);
// The checked-in browser configuration enables local role simulation. Keep the
// local server aligned by default; deployments can explicitly disable it.
const demoAuthEnabled = process.env.BRMS_DEMO_AUTH !== '0';
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const uploadDir = path.resolve(process.env.BRMS_UPLOAD_DIR || path.join(dataDir, 'uploads'));
fs.mkdirSync(uploadDir, { recursive: true });
const databasePath = process.env.BRMS_DB_PATH || path.join(dataDir, 'brms.sqlite');
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_normalized TEXT NOT NULL UNIQUE, department TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_normalized TEXT NOT NULL UNIQUE, project_type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), version TEXT NOT NULL, release_date TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, version));
CREATE TABLE IF NOT EXISTS requirement_sequences (project_id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requirements (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, project_id TEXT REFERENCES projects(id), payload TEXT NOT NULL, status TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', version_confirmed INTEGER NOT NULL DEFAULT 0, release_date TEXT NOT NULL DEFAULT '', archived_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requirement_histories (id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rich_text_assets (url TEXT PRIMARY KEY, filename TEXT NOT NULL UNIQUE, uploaded_by TEXT NOT NULL, requirement_id TEXT REFERENCES requirements(id), created_at TEXT NOT NULL, claimed_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES users(id), requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS requirements_lookup ON requirements(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS histories_lookup ON requirement_histories(requirement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rich_text_assets_requirement_lookup ON rich_text_assets(requirement_id);
CREATE INDEX IF NOT EXISTS messages_recipient_lookup ON messages(recipient_id, created_at DESC);
`);
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
if (!userColumns.includes('name_normalized')) {
  db.exec('ALTER TABLE users ADD COLUMN name_normalized TEXT');
  db.exec("UPDATE users SET name_normalized = lower(trim(name)) WHERE name_normalized IS NULL");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_name_normalized_unique ON users(name_normalized)');
}
if (!userColumns.includes('roles')) {
  db.exec("ALTER TABLE users ADD COLUMN roles TEXT NOT NULL DEFAULT '[]'");
}
if (!userColumns.includes('password_hash')) db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''");
if (!userColumns.includes('password_updated_at')) db.exec("ALTER TABLE users ADD COLUMN password_updated_at TEXT NOT NULL DEFAULT ''");
const requirementColumns = db.prepare('PRAGMA table_info(requirements)').all().map((column) => column.name);
if (!requirementColumns.includes('archived_at')) db.exec("ALTER TABLE requirements ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''");

const roles = { requester: '业务需求方', screener: '业务需求质量管理员', product: '产品', engineer: '研发', admin: '系统管理员' };
const presetProjects = [
  { id: legacyProjectIds.get('p1'), name: '柚省业务' },
  { id: legacyProjectIds.get('p2'), name: '返现业务' },
  { id: legacyProjectIds.get('p3'), name: '返还网业务' },
  { id: legacyProjectIds.get('p4'), name: '柚子街业务' },
  { id: legacyProjectIds.get('p5'), name: '羊毛省钱业务' }
];
const terminal = new Set(['完成发布', '需求撤销', '需求终止']);
const productionStages = new Set(['待投产', '产品设计', '研发实施', '完成发布']);
const productSupplementStages = new Set(['待预审', ...productionStages, '需求终止']);
const engineeringNoteStages = new Set([...productionStages, '需求终止']);
const sourceValueMigration = Object.freeze({
  '运营需求': '运营',
  '产品需求': '产品',
  '技术需求': '研发',
  '设计需求': '设计',
  '安全需求': '安全合规',
  '客户反馈': '用户反馈',
  '商务合作': '商务合作'
});
const sources = new Set(['运营', '产品', '研发', '设计', '安全合规', '用户反馈', '商务合作']);
const todoDefinitions = [
  ['待评估', '待评估需求', '等待完成需求初筛', 'rose'],
  ['待需求方重新评估', '已退回需求', '需要补充或修改后重新提交', 'amber'],
  ['待预审', '待预审需求', '等待完成业务预审', 'blue'],
  ['待投产', '等待投产', '等待确认版本与排期', 'yellow'],
  ['产品设计', '产品设计中', '正在完成产品方案与设计交付', 'purple'],
  ['研发实施', '研发中', '正在进行研发、测试与验收', 'cyan']
];
const returnedByMeTodo = ['被我退回的需求', '被我退回的需求', '等待需求方补充后重新评估', 'purple'];
const todoStageRoles = {
  '待评估': new Set(['screener', 'admin']),
  '待需求方重新评估': new Set(['requester', 'admin']),
  '待预审': new Set(['product', 'admin']),
  '待投产': new Set(['product', 'admin']),
  '产品设计': new Set(['product', 'admin']),
  '研发实施': new Set(['product', 'engineer', 'admin'])
};
const workbenchDefinitions = (actor) => {
  const definitions = actor.key === 'screener'
    ? todoDefinitions.filter(([status]) => status === '待评估')
    : todoDefinitions;
  return ['screener', 'product', 'admin'].includes(actor.key) ? [...definitions, returnedByMeTodo] : definitions;
};
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const temporaryPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  return Array.from(crypto.randomBytes(16), (byte) => alphabet[byte % alphabet.length]).join('');
};
const passwordHash = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
};
const norm = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const queryValues = (params, key) => params.getAll(key).flatMap((value) => norm(value).split(',')).filter(Boolean);
const parse = (value) => JSON.parse(value || '{}');
const fail = (code, message, status = 422) => { const err = new Error(message); err.code = code; err.status = status; throw err; };
const required = (value, message, code = 'VALIDATION_ERROR') => norm(value) || fail(code, message);
const uploadedImagePath = /^\/uploads\/[a-f0-9-]+\.(?:png|jpe?g|webp|gif)$/i;
const clean = (html) => sanitizeHtml(String(html || ''), {
  allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'code', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img'],
  allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }, true),
    img: (tagName, attribs) => uploadedImagePath.test(attribs.src || '') ? ({ tagName, attribs }) : ({ tagName: 'span', text: '' })
  }
});
const htmlText = (html) => clean(html).replace(/<img\b[^>]*>/gi, '图片').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
const referencedAssetUrls = (html = '') => [...clean(html).matchAll(/<img\b[^>]*\bsrc="([^"\s]+)"[^>]*>/gi)].map((match) => match[1]).filter((url) => uploadedImagePath.test(url));
const user = (userId) => userId && db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
const project = (projectId) => projectId && db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
const version = (projectId, versionName) => db.prepare('SELECT * FROM project_versions WHERE project_id = ? AND lower(version) = lower(?)').get(projectId, versionName);
const userRoles = (row) => {
  if (!row) return [];
  if (Array.isArray(row.roles)) return [...new Set(row.roles.filter((role) => Object.values(roles).includes(role)))];
  try {
    const values = JSON.parse(row.roles || '[]');
    if (Array.isArray(values) && values.length) return [...new Set(values.filter((role) => Object.values(roles).includes(role)))];
  } catch {}
  return Object.values(roles).includes(row.role) ? [row.role] : [];
};
const hasRole = (row, role) => userRoles(row).includes(role);
const normalizedRoles = (value) => {
  const values = Array.isArray(value) ? value : [value];
  const selected = [...new Set(values.map(norm).filter(Boolean))];
  if (!selected.length || selected.some((role) => !Object.values(roles).includes(role))) fail('VALIDATION_ERROR', '角色不合法');
  return selected;
};
const publicUser = (row) => row && ({ id: row.id, name: row.name, department: row.department, role: userRoles(row)[0] || row.role, roles: userRoles(row), status: row.status });
const publicProject = (row) => row && ({ id: row.id, name: row.name, projectType: row.project_type, description: row.description, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
const publicVersion = (row) => row && ({ id: row.id, projectId: row.project_id, projectName: project(row.project_id)?.name || '', version: row.version, releaseDate: row.release_date, createdAt: row.created_at, updatedAt: row.updated_at });
const getActor = (roleKey, userId) => {
  const role = roles[roleKey] || roles.requester;
  const selected = user(userId);
  const row = selected && selected.status === '启用' && hasRole(selected, role)
    ? selected
    : db.prepare("SELECT * FROM users WHERE status = '启用' ORDER BY id").all().find((item) => hasRole(item, role)) || user('u1');
  const key = Object.entries(roles).find(([, label]) => label === role)?.[0] || 'requester';
  return { ...publicUser(row), role, key };
};
const requireRole = (actor, allowed) => { if (actor.role !== '系统管理员' && !allowed.includes(actor.role)) fail('FORBIDDEN', '无权限执行此操作', 403); };
const checkUser = (value, label, must = false) => { if (!value && !must) return null; const row = user(value); if (!row || row.status !== '启用') fail('VALIDATION_ERROR', `${label}不存在或已停用`); return row; };

function projectInitials(name) {
  const normalizedName = String(name || '').replace(/业务|app/gi, '');
  return pinyin(normalizedName, { pattern: 'first', toneType: 'none', type: 'array' })
    .map((letter) => String(letter).toUpperCase())
    .filter((letter) => /^[A-Z]$/.test(letter))
    .join('')
    .slice(0, 4) || 'WLX';
}
function nextCode(projectId) {
  const sequenceId = projectId || '__unlinked__';
  const sequence = db.prepare('SELECT next_sequence FROM requirement_sequences WHERE project_id = ?').get(sequenceId)?.next_sequence || 1;
  db.prepare('INSERT INTO requirement_sequences(project_id, next_sequence) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET next_sequence = excluded.next_sequence').run(sequenceId, sequence + 1);
  const prefix = projectInitials(project(projectId)?.name);
  return `${prefix}-${String(sequence).padStart(3, '0')}`;
}
function transaction(work) { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (err) { db.exec('ROLLBACK'); throw err; } }
function reconcileRichTextAssets() {
  const claim = db.prepare("UPDATE rich_text_assets SET requirement_id = ?, claimed_at = ? WHERE url = ? AND requirement_id IS NULL");
  const add = db.prepare('INSERT OR IGNORE INTO rich_text_assets(url, filename, uploaded_by, requirement_id, created_at, claimed_at) VALUES (?, ?, ?, ?, ?, ?)');
  db.prepare('SELECT id, payload, created_at FROM requirements').all().forEach((row) => {
    const payload = parse(row.payload);
    [payload.descriptionHtml, payload.requesterNoteHtml, payload.implementationNoteHtml, payload.engineeringNoteHtml,
      ...(payload.requesterNotes || []).map((note) => note.contentHtml),
      ...(payload.implementationNotes || []).map((note) => note.contentHtml),
      ...(payload.engineeringNotes || []).map((note) => note.contentHtml)
    ].flatMap(referencedAssetUrls).forEach((url) => {
      const filename = url.slice('/uploads/'.length);
      if (!fs.existsSync(path.join(uploadDir, filename))) return;
      add.run(url, filename, payload.requesterOwnerId || 'system', row.id, row.created_at, row.created_at);
      claim.run(row.id, row.created_at, url);
    });
  });
}
function migrateRequirementSources() {
  const update = db.prepare('UPDATE requirements SET payload = ? WHERE id = ?');
  let migrated = 0;
  transaction(() => {
    db.prepare('SELECT id, payload FROM requirements').all().forEach((row) => {
      const payload = parse(row.payload);
      const source = sourceValueMigration[payload.source];
      if (!source || source === payload.source) return;
      payload.source = source;
      update.run(JSON.stringify(payload), row.id);
      migrated += 1;
    });
  });
  return migrated;
}
function migrateRequesterRoleLabel() {
  const replaceRoleLabel = (value) => {
    if (Array.isArray(value)) return value.map(replaceRoleLabel);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'role' && item === '业务方' ? '业务需求方' : replaceRoleLabel(item)]));
  };
  const updateRequirement = db.prepare('UPDATE requirements SET payload = ? WHERE id = ?');
  const updateHistory = db.prepare('UPDATE requirement_histories SET payload = ? WHERE id = ?');
  const updateMessage = db.prepare('UPDATE messages SET payload = ? WHERE id = ?');
  const migratePayloads = (table, update) => {
    db.prepare(`SELECT id, payload FROM ${table}`).all().forEach((row) => {
      const payload = parse(row.payload);
      const migrated = replaceRoleLabel(payload);
      if (JSON.stringify(payload) !== JSON.stringify(migrated)) update.run(JSON.stringify(migrated), row.id);
    });
  };
  transaction(() => {
    db.prepare("UPDATE users SET role = '业务需求方' WHERE role = '业务方'").run();
    migratePayloads('requirements', updateRequirement);
    migratePayloads('requirement_histories', updateHistory);
    migratePayloads('messages', updateMessage);
  });
}
function migrateUserRoles() {
  const update = db.prepare('UPDATE users SET roles = ?, role = ? WHERE id = ?');
  transaction(() => {
    db.prepare('SELECT * FROM users').all().forEach((row) => {
      const selected = userRoles(row);
      const rolesForUser = selected.length ? selected : normalizedRoles(row.role);
      const primaryRole = rolesForUser[0];
      if (row.roles !== JSON.stringify(rolesForUser) || row.role !== primaryRole) update.run(JSON.stringify(rolesForUser), primaryRole, row.id);
    });
  });
}
function migrateProductDesignStatus() {
  const updateRequirement = db.prepare("UPDATE requirements SET status = '产品设计' WHERE status = '产品方案设计'");
  const updateHistory = db.prepare('UPDATE requirement_histories SET payload = ? WHERE id = ?');
  transaction(() => {
    updateRequirement.run();
    db.prepare('SELECT id, payload FROM requirement_histories').all().forEach((row) => {
      const payload = parse(row.payload);
      let changed = false;
      ['from', 'to'].forEach((key) => {
        if (payload[key] === '产品方案设计') {
          payload[key] = '产品设计';
          changed = true;
        }
      });
      if (payload.action === '开始产品方案设计') {
        payload.action = '开始产品设计';
        changed = true;
      }
      if (changed) updateHistory.run(JSON.stringify(payload), row.id);
    });
  });
}
function migrateRequirementCodes() {
  const projectRows = db.prepare('SELECT id, name FROM projects').all();
  const requirementRows = db.prepare('SELECT id, code, project_id FROM requirements ORDER BY created_at, id').all();
  const updateCode = db.prepare('UPDATE requirements SET code = ? WHERE id = ?');
  const upsertSequence = db.prepare(`
    INSERT INTO requirement_sequences(project_id, next_sequence) VALUES (?, ?)
    ON CONFLICT(project_id) DO UPDATE SET next_sequence = excluded.next_sequence
  `);

  transaction(() => {
    [...projectRows, { id: null, name: '' }].forEach((projectRow) => {
      const prefix = `${projectInitials(projectRow.name)}-`;
      const pattern = new RegExp(`^(?:BR-)?${prefix}(\\d{3,})$`);
      const items = requirementRows.filter((item) => item.project_id === projectRow.id);
      const usedCodes = new Set(items.filter((item) => item.code.startsWith(prefix)).map((item) => item.code));
      let maxSequence = items.reduce((max, item) => Math.max(max, Number(item.code.match(pattern)?.[1] || 0)), 0);
      const changes = [];

      items.forEach((item) => {
        const match = item.code.match(pattern);
        let code = match ? `${prefix}${match[1]}` : '';
        if (!code || (code !== item.code && usedCodes.has(code))) {
          do { maxSequence += 1; code = `${prefix}${String(maxSequence).padStart(3, '0')}`; } while (usedCodes.has(code));
        }
        usedCodes.add(code);
        maxSequence = Math.max(maxSequence, Number(code.match(/(\d+)$/)?.[1] || 0));
        if (code !== item.code) changes.push({ id: item.id, code });
      });

      // Temporary values avoid unique-key collisions while shortening legacy codes.
      changes.forEach((item) => updateCode.run(`__code-migration-${item.id}`, item.id));
      changes.forEach((item) => updateCode.run(item.code, item.id));
      upsertSequence.run(projectRow.id || '__unlinked__', maxSequence + 1);
    });
  });
}
function migrateRequesterOwners() {
  const update = db.prepare('UPDATE requirements SET payload = ? WHERE id = ?');
  let migrated = 0;
  transaction(() => {
    db.prepare('SELECT id, payload FROM requirements').all().forEach((row) => {
      const payload = parse(row.payload);
      const initiator = db.prepare('SELECT id FROM users WHERE name = ?').get(payload.requester);
      if (!initiator || payload.requesterOwnerId === initiator.id) return;
      payload.requesterOwnerId = initiator.id;
      update.run(JSON.stringify(payload), row.id);
      migrated += 1;
    });
  });
  return migrated;
}
const noteThreads = [
  { input: 'requesterNoteHtml', key: 'requesterNotes', legacy: 'requesterNoteHtml', label: '需求补充说明' },
  { input: 'implementationNoteHtml', key: 'implementationNotes', legacy: 'implementationNoteHtml', label: '产品·补充说明' },
  { input: 'engineeringNoteHtml', key: 'engineeringNotes', legacy: 'engineeringNoteHtml', label: '研发·补充说明' }
];
function migrateRequirementNoteThreads() {
  const update = db.prepare('UPDATE requirements SET payload = ? WHERE id = ?');
  transaction(() => {
    db.prepare('SELECT id, payload, created_at, updated_at FROM requirements').all().forEach((row) => {
      const payload = parse(row.payload);
      let changed = false;
      noteThreads.forEach((spec) => {
        if (Array.isArray(payload[spec.key])) return;
        const contentHtml = clean(payload[spec.legacy]);
        payload[spec.key] = htmlText(contentHtml) ? [{ at: row.updated_at || row.created_at, operator: payload.requester || '系统', role: '历史记录', contentHtml }] : [];
        changed = true;
      });
      if (changed) update.run(JSON.stringify(payload), row.id);
    });
  });
}
function migrateMessageLabels() {
  const replacements = [['需求方备注', '需求补充说明'], ['实施补充说明', '产品·补充说明'], ['研发备注', '研发·补充说明']];
  const update = db.prepare('UPDATE messages SET payload = ? WHERE id = ?');
  db.prepare('SELECT id, payload FROM messages').all().forEach((row) => {
    const payload = parse(row.payload);
    let changed = false;
    ['title', 'summary'].forEach((key) => {
      if (!payload[key]) return;
      let value = payload[key];
      replacements.forEach(([from, to]) => { if (value.includes(from)) { value = value.replaceAll(from, to); changed = true; } });
      payload[key] = value;
    });
    if (changed) update.run(JSON.stringify(payload), row.id);
  });
}
function migrateHistoryLabels() {
  const replacements = [['需求方备注', '需求补充说明'], ['实施补充说明', '产品·补充说明'], ['研发备注', '研发·补充说明']];
  const update = db.prepare('UPDATE requirement_histories SET payload = ? WHERE id = ?');
  db.prepare('SELECT id, payload FROM requirement_histories').all().forEach((row) => {
    const payload = parse(row.payload);
    let changed = false;
    ['action', 'note'].forEach((key) => {
      if (!payload[key]) return;
      let value = payload[key];
      replacements.forEach(([from, to]) => { if (value.includes(from)) { value = value.replaceAll(from, to); changed = true; } });
      payload[key] = value;
    });
    if (changed) update.run(JSON.stringify(payload), row.id);
  });
}
function history(requirementId, item) { db.prepare('INSERT INTO requirement_histories VALUES (?, ?, ?, ?)').run(id(), requirementId, JSON.stringify(item), item.at); }
function requirement(row) {
  const payload = parse(row.payload), projectRecord = project(row.project_id), productOwner = user(payload.productOwnerId), requesterOwner = user(payload.requesterOwnerId);
  return { ...payload, id: row.id, code: row.code, projectId: row.project_id || '', projectName: projectRecord?.name || '', productOwnerName: productOwner?.name || '', requesterOwnerName: requesterOwner?.name || '', status: row.status, version: row.version, versionConfirmed: Boolean(row.version_confirmed), releaseDate: row.release_date || '', archivedAt: row.archived_at || '', createdAt: row.created_at, updatedAt: row.updated_at, history: db.prepare('SELECT payload FROM requirement_histories WHERE requirement_id = ? ORDER BY created_at DESC').all(row.id).map((item) => parse(item.payload)) };
}
const getRequirement = (requirementId) => { const row = db.prepare('SELECT * FROM requirements WHERE id = ?').get(requirementId); return row && requirement(row); };
// Business requirements are shared records: every authenticated role may read
// their details. Edit and workflow permissions are enforced separately.
const canReadRequirement = () => true;
const wasReturnedBy = (item, actor) => item.status === '待需求方重新评估'
  && ['初筛退回', '预审退回'].includes(item.history[0]?.action)
  && item.history[0]?.operator === actor.name;
const archiveCutoff = () => {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  cutoff.setHours(23, 59, 59, 999);
  return cutoff;
};
const isArchivedRequirement = (item, cutoff = archiveCutoff()) => item.status === '完成发布' && (item.archivedAt || (item.releaseDate && new Date(`${item.releaseDate}T00:00:00`) <= cutoff));
const canReadArchiveRequirement = (actor, item) => isArchivedRequirement(item) || canReadRequirement(actor, item);
function archiveRequirements(actor, keyword = '') {
  const cutoff = archiveCutoff();
  const visible = db.prepare('SELECT * FROM requirements').all().map(requirement);
  const groups = new Map();
  visible.filter((item) => isArchivedRequirement(item, cutoff))
    .filter((item) => !keyword || `${item.code}${item.title}${item.projectName}${item.version}`.toLowerCase().includes(keyword.toLowerCase()))
    .forEach((item) => {
      const projectName = item.projectName || '未关联项目';
      const versionName = item.versionConfirmed && item.version ? item.version : '未确认版本';
      const key = `${item.projectId || projectName}::${versionName}`;
      const versionRecord = item.projectId && item.version ? version(item.projectId, item.version) : null;
      if (!groups.has(key)) groups.set(key, { projectId: item.projectId || '', projectName, version: versionName, versionReleaseDate: versionRecord?.release_date || '', requirements: [] });
      groups.get(key).requirements.push(item);
    });
  const items = [...groups.values()].map((group) => ({
    ...group,
    requirements: group.requirements.sort((first, second) => String(second.releaseDate).localeCompare(String(first.releaseDate)))
  })).sort((first, second) => String(second.requirements[0]?.releaseDate || '').localeCompare(String(first.requirements[0]?.releaseDate || '')));
  return { cutoff: cutoff.toISOString(), total: items.reduce((count, group) => count + group.requirements.length, 0), groupCount: items.length, items };
}
function workbench(actor, requestedStatus = '') {
  const definitions = workbenchDefinitions(actor);
  const statuses = new Set(definitions.map(([status]) => status));
  if (requestedStatus && !statuses.has(requestedStatus)) fail('NOT_FOUND', '待办分类不存在', 404);
  const isRelated = (item) => actor.key === 'requester'
    ? item.requesterOwnerId === actor.id
    : item.requester === actor.name
      || item.requesterOwnerId === actor.id
      || todoStageRoles[item.status]?.has(actor.key);
  const related = db.prepare('SELECT * FROM requirements').all().map(requirement).filter(isRelated);
  const itemsFor = (status) => status === returnedByMeTodo[0]
    ? db.prepare('SELECT * FROM requirements').all().map(requirement).filter((item) => wasReturnedBy(item, actor))
    : related.filter((item) => item.status === status);
  const cards = definitions.map(([status, title, description, tone]) => ({
    status, title, description, tone, count: itemsFor(status).length
  }));
  const activeStatus = requestedStatus || cards[0]?.status || '';
  const matches = itemsFor(activeStatus)
    .sort((first, second) => String(second.updatedAt).localeCompare(String(first.updatedAt)));
  return { cards, activeStatus, total: matches.length, items: matches.slice(0, 5) };
}
function persist(record, original, at) { db.prepare('UPDATE requirements SET project_id = ?, payload = ?, status = ?, version = ?, version_confirmed = ?, release_date = ?, archived_at = ?, updated_at = ? WHERE id = ?').run(record.projectId || null, JSON.stringify(record), record.status, record.version || '', record.versionConfirmed ? 1 : 0, record.releaseDate || '', record.archivedAt || '', at, original.id); return getRequirement(original.id); }
function messageRecipients(record, actor) {
  const ids = new Set([record.requesterOwnerId, record.productOwnerId].filter(Boolean));
  const stageRoles = record.status === '待评估' ? ['业务需求质量管理员']
    : record.status === '待需求方重新评估' ? ['业务需求质量管理员']
    : ['待预审', '待投产', '产品设计'].includes(record.status) ? ['产品']
      : ['研发实施', '需求终止'].includes(record.status) ? ['产品', '研发'] : [];
  stageRoles.forEach((role) => db.prepare("SELECT * FROM users WHERE status = '启用'").all().filter((row) => hasRole(row, role)).forEach((row) => ids.add(row.id)));
  if (record.status === '待需求方重新评估') {
    const returnOperator = record.history.find((item) => ['初筛退回', '预审退回'].includes(item.action))?.operator;
    const returnUser = returnOperator && db.prepare('SELECT * FROM users WHERE name = ? AND status = \'启用\'').get(returnOperator);
    if (returnUser) ids.add(returnUser.id);
  }
  ids.delete(actor.id);
  return [...ids];
}
function noteText(html) { return clean(html).replace(/<img\b[^>]*>/gi, '图片').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 80); }
function notifyRequirementEvent(record, actor, type, payload, at) {
  const insert = db.prepare('INSERT INTO messages(id, recipient_id, requirement_id, type, payload, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, \'\')');
  messageRecipients(record, actor).forEach((recipientId) => insert.run(id(), recipientId, record.id, type, JSON.stringify(payload), at));
}
function notifyNoteUpdates(record, actor, changedNotes, at) {
  if (!changedNotes.length) return;
  const label = changedNotes.map((note) => note.label).join('、');
  const excerpt = noteText(changedNotes[0]?.contentHtml || '');
  notifyRequirementEvent(record, actor, 'note_updated', { title: `${label}已更新`, summary: `${actor.name} 更新了${label}${excerpt ? `：${excerpt}` : ''}`, operator: actor.name, status: record.status }, at);
}
function notifyWorkflowUpdate(record, actor, historyItem, at) {
  const workflowChange = `需求状态由 @${historyItem.operator} 从 ${historyItem.from || '-'} 变更为 ${historyItem.to || record.status}`;
  notifyRequirementEvent(record, actor, 'workflow_updated', {
    title: '需求流程已更新',
    summary: workflowChange,
    workflowChange,
    operator: actor.name,
    action: historyItem.action,
    from: historyItem.from || '-',
    to: historyItem.to || record.status,
    status: record.status
  }, at);
}
function messages(actor, limit = 5) {
  return db.prepare('SELECT * FROM messages WHERE recipient_id = ? ORDER BY created_at DESC LIMIT ?').all(actor.id, limit).map((row) => {
    const record = getRequirement(row.requirement_id), payload = parse(row.payload);
    return { id: row.id, requirementId: row.requirement_id, requirementCode: record?.code || '', requirementTitle: record?.title || '需求已删除', projectName: record?.projectName || '', type: row.type, ...payload, createdAt: row.created_at, readAt: row.read_at };
  });
}
function requirementActivities(actor, limit = 1) {
  const statusTitles = new Map(todoDefinitions.map(([status, title]) => [status, title]));
  const activities = new Map();
  db.prepare("SELECT * FROM messages WHERE recipient_id = ? AND read_at = '' ORDER BY created_at DESC").all(actor.id).forEach((row) => {
    const record = getRequirement(row.requirement_id);
    if (!record) return;
    const payload = parse(row.payload);
    const existing = activities.get(record.id) || {
      requirementId: record.id,
      requirementCode: record.code,
      requirementTitle: record.title,
      projectName: record.projectName || '',
      status: record.status,
      statusTitle: statusTitles.get(record.status) || record.status,
      count: 0,
      requesterNoteUpdates: 0,
      implementationNoteUpdates: 0,
      engineeringNoteUpdates: 0,
      latestRequesterNote: null,
      latestImplementationNote: null,
      latestEngineeringNote: null,
      workflowUpdates: 0,
      latestWorkflowChange: '',
      latestWorkflow: null,
      updatedAt: row.created_at
    };
    existing.count += 1;
    if (row.type === 'workflow_updated') {
      existing.workflowUpdates += 1;
      if (!existing.latestWorkflowChange) {
        const historyItem = record.history?.find((item) => item.at === row.created_at)
          || record.history?.find((item) => item.operator === payload.operator && item.action === payload.action);
        const from = payload.from || historyItem?.from || '-';
        const to = payload.to || historyItem?.to || record.status;
        const operator = payload.operator || historyItem?.operator || '';
        existing.latestWorkflowChange = payload.workflowChange
          || (operator ? `需求状态由 @${operator} 从 ${from} 变更为 ${to}` : payload.summary || '需求流程已更新');
        existing.latestWorkflow = operator ? { operator, from, to, at: row.created_at } : null;
      }
    }
    if (payload.title?.includes('需求补充说明')) {
      existing.requesterNoteUpdates += 1;
      if (!existing.latestRequesterNote) existing.latestRequesterNote = { at: row.created_at };
    }
    if (payload.title?.includes('产品·补充说明')) {
      existing.implementationNoteUpdates += 1;
      if (!existing.latestImplementationNote) existing.latestImplementationNote = { at: row.created_at };
    }
    if (payload.title?.includes('研发·补充说明')) {
      existing.engineeringNoteUpdates += 1;
      if (!existing.latestEngineeringNote) existing.latestEngineeringNote = { at: row.created_at };
    }
    activities.set(record.id, existing);
  });
  return [...activities.values()].sort((first, second) => String(second.updatedAt).localeCompare(String(first.updatedAt))).slice(0, limit);
}
function readRequirementActivity(requirementId, actor) {
  const requirement = getRequirement(requirementId);
  if (!requirement || !canReadArchiveRequirement(actor, requirement)) fail('NOT_FOUND', '需求动态不存在', 404);
  const at = now();
  const result = db.prepare("UPDATE messages SET read_at = ? WHERE recipient_id = ? AND requirement_id = ? AND read_at = ''").run(at, actor.id, requirementId);
  return { requirementId, readCount: result.changes, readAt: at };
}
function readAllRequirementActivities(actor) {
  const at = now();
  const result = db.prepare("UPDATE messages SET read_at = ? WHERE recipient_id = ? AND read_at = ''").run(at, actor.id);
  return { readCount: result.changes, readAt: at };
}

function createRequirement(input, actor) {
  if (!hasRole(actor, '业务需求方') && !hasRole(actor, '系统管理员')) fail('FORBIDDEN', '当前用户不具备发起需求权限', 403);
  required(input.title, '请填写需求简述'); if (!htmlText(input.descriptionHtml)) fail('VALIDATION_ERROR', '请填写需求详细描述');
  const source = required(input.source, '请选择需求来源'); if (!sources.has(source)) fail('VALIDATION_ERROR', '需求来源不合法');
  const projectId = required(input.projectId, '请选择所属项目'); if (!project(projectId)) fail('NOT_FOUND', '所属项目不存在', 404);
  if ('productOwnerId' in input) fail('FORBIDDEN', '产品Owner只能在预审通过时由业务系统管理员分配', 403);
  if (input.requesterOwnerId && input.requesterOwnerId !== actor.id) fail('FORBIDDEN', '需求方必须与发起人一致', 403);
  const requesterOwner = actor, at = now();
  return transaction(() => { const requesterNoteHtml = clean(input.requesterNoteHtml), payload = { title:norm(input.title), source, descriptionHtml:clean(input.descriptionHtml), requesterNoteHtml:'', implementationNoteHtml:'', engineeringNoteHtml:'', requesterNotes:htmlText(requesterNoteHtml)?[{at,operator:actor.name,role:actor.role,contentHtml:requesterNoteHtml}]:[], implementationNotes:[], engineeringNotes:[], requester:actor.name, requesterOwnerId:requesterOwner.id, productOwnerId:'', terminationReason:'', returnNotes:[], currentHandler:'业务需求质量管理员', versionReleaseDate:'' }, requirementId = id(), historyItem = { at,operator:actor.name,role:actor.role,action:'发起需求',from:'-',to:'待评估',note:htmlText(requesterNoteHtml)?'新增需求补充说明':'' }; db.prepare('INSERT INTO requirements(id, code, project_id, payload, status, version, version_confirmed, release_date, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(requirementId, nextCode(projectId), projectId, JSON.stringify(payload), '待评估', '', 0, '', '', at, at); history(requirementId, historyItem); const created = getRequirement(requirementId); notifyWorkflowUpdate(created, actor, historyItem, at); return created; });
}
function updateRequirement(requirementId, input, actor) {
  const old = getRequirement(requirementId); if (!old) fail('NOT_FOUND', '需求不存在', 404); if (input.updatedAt && input.updatedAt !== old.updatedAt) fail('STATE_CONFLICT', '需求已被其他操作更新，请刷新后重试', 409);
  const requesterOwnsRequirement = actor.role === '业务需求方' && old.requesterOwnerId === actor.id;
  const business = requesterOwnsRequirement && !['待投产','产品设计','研发实施',...terminal].includes(old.status), productUser = actor.role === '产品', engineer = actor.role === '研发';
  const updatingRequester = Object.hasOwn(input, 'requesterNoteHtml'), updatingImplementation = Object.hasOwn(input, 'implementationNoteHtml'), updatingEngineering = Object.hasOwn(input, 'engineeringNoteHtml');
  const editableRequirementFields = ['title', 'descriptionHtml', 'source', 'projectId'];
  const updatingRequirementFields = editableRequirementFields.some((field) => Object.hasOwn(input, field));
  const requesterCanAddNote = requesterOwnsRequirement && updatingRequester && !updatingRequirementFields;
  if (requesterOwnsRequirement && !business && updatingRequirementFields) fail('FORBIDDEN', '当前阶段仅支持添加需求补充说明', 403);
  if (actor.role !== '系统管理员' && !business && !productUser && !engineer && !requesterCanAddNote) fail('FORBIDDEN', '当前身份不能编辑该需求', 403);
  if ('productOwnerId' in input) fail('FORBIDDEN', '产品Owner只能在预审通过时由业务系统管理员分配', 403);
  if ('requesterOwnerId' in input && input.requesterOwnerId !== old.requesterOwnerId) fail('FORBIDDEN', '需求方不允许调整', 403);
  if (updatingRequester && !(requesterOwnsRequirement || productUser || actor.role === '系统管理员')) fail('FORBIDDEN', '无权限维护需求补充说明', 403);
  if (updatingImplementation && actor.role !== '系统管理员' && !productSupplementStages.has(old.status)) fail('FORBIDDEN', '产品·补充说明仅可在待预审及之后维护', 403);
  if (updatingEngineering && actor.role !== '系统管理员' && !engineeringNoteStages.has(old.status)) fail('FORBIDDEN', '研发·补充说明仅可在待投产及之后维护', 403);
  if (updatingImplementation && !['产品', '系统管理员'].includes(actor.role)) fail('FORBIDDEN', '无权限维护产品·补充说明', 403);
  if (updatingEngineering && !['研发', '系统管理员'].includes(actor.role)) fail('FORBIDDEN', '无权限维护研发·补充说明', 403);
  const next = { ...old }; if (business || productUser || actor.role === '系统管理员') { if ('title' in input) next.title = required(input.title, '请填写需求简述'); if ('descriptionHtml' in input) { if (!htmlText(input.descriptionHtml)) fail('VALIDATION_ERROR', '请填写需求详细描述'); next.descriptionHtml = clean(input.descriptionHtml); } if ('source' in input) { if (input.source && !sources.has(input.source)) fail('VALIDATION_ERROR', '需求来源不合法'); next.source=input.source || ''; } if ('projectId' in input) { if (input.projectId && !project(input.projectId)) fail('NOT_FOUND','所属项目不存在',404); next.projectId=input.projectId || ''; } }
  const at=now(), changedNotes=[];
  noteThreads.forEach((spec) => {
    if (!Object.hasOwn(input, spec.input)) return;
    const contentHtml = clean(input[spec.input]);
    if (!htmlText(contentHtml)) return;
    next[spec.key] = [...(Array.isArray(old[spec.key]) ? old[spec.key] : []), { at, operator: actor.name, role: actor.role, contentHtml }];
    changedNotes.push({ label: spec.label, contentHtml });
  });
  return transaction(() => { persist(next,old,at); notifyNoteUpdates(next, actor, changedNotes, at); history(old.id,{at,operator:actor.name,role:actor.role,action:'更新需求内容',from:old.status,to:old.status,note:changedNotes.length ? `新增${changedNotes.map((note) => note.label).join('、')}` : ''}); return getRequirement(old.id); });
}
function actionRequirement(requirementId, input, actor) {
  const old=getRequirement(requirementId); if (!old) fail('NOT_FOUND','需求不存在',404); if (!input.updatedAt || input.updatedAt !== old.updatedAt) fail('STATE_CONFLICT','需求状态已更新，请刷新后重试',409);
  if (input.action === 'archive') {
    requireRole(actor, ['产品']);
    if (old.status !== '完成发布') fail('STATE_CONFLICT', '仅已完成发布的需求可以归档', 409);
    if (old.archivedAt) fail('STATE_CONFLICT', '该需求已归档', 409);
    const at = now(), next = { ...old, archivedAt: at };
    persist(next, old, at);
    const historyItem = { at, operator: actor.name, role: actor.role, action: '需求归档', from: old.status, to: old.status, note: '手动归档' };
    history(old.id, historyItem);
    const archived = getRequirement(old.id); notifyWorkflowUpdate(archived, actor, historyItem, at);
    return archived;
  }
  if (terminal.has(old.status)) fail('STATE_CONFLICT','终态需求不能继续流转',409);
  const rules={ pass:{role:'业务需求质量管理员',from:'待评估',to:'待预审',name:'初筛通过'}, return:{role:'业务需求质量管理员',from:'待评估',to:'待需求方重新评估',name:'初筛退回',reason:true}, resubmit:{role:'业务需求方',from:'待需求方重新评估',to:'待评估',name:'重新提交需求'}, pre:{role:'系统管理员',from:'待预审',to:'待投产',name:'预审通过并分配产品Owner',owner:true}, preReturn:{role:'产品',from:'待预审',to:'待需求方重新评估',name:'预审退回',reason:true}, directToProduction:{role:'系统管理员',from:'待需求方重新评估',to:'待投产',name:'重新评估后预审通过并分配产品Owner',owner:true}, startProductDesign:{role:'产品',from:'待投产',to:'产品设计',name:'开始产品设计',version:true}, startEngineering:{role:'产品',from:'产品设计',to:'研发实施',name:'开始研发实施'}, release:{role:'产品',from:'研发实施',to:'完成发布',release:true}, withdraw:{role:'业务需求方',to:'需求撤销',name:'撤销需求'}, terminate:{role:'产品',to:'需求终止',name:'终止需求',reason:true} };
  const rule=rules[input.action]; if (!rule) fail('VALIDATION_ERROR','未知状态动作'); requireRole(actor,[rule.role]); if (rule.from && old.status !== rule.from) fail('STATE_CONFLICT','当前状态不允许该动作',409); if (input.action==='terminate'&&!productionStages.has(old.status)) fail('FORBIDDEN','需求进入待投产后才可终止',403); if ((input.action === 'withdraw' || input.action === 'resubmit') && actor.role !== '系统管理员' && old.requesterOwnerId !== actor.id) fail('FORBIDDEN','仅需求发起人可以执行该操作',403); if (input.action === 'withdraw' && productionStages.has(old.status)) fail('FORBIDDEN','当前需求不能撤销',403); if (rule.reason) required(input.reason,input.action==='terminate'?'请填写终止原因':'请填写退回原因',input.action==='terminate'?'TERMINATION_REASON_REQUIRED':'VALIDATION_ERROR');
  const next={...old,status:rule.to}; if(rule.owner){const ownerId=required(input.productOwnerId,'请选择产品Owner','PRODUCT_OWNER_REQUIRED'),owner=checkUser(ownerId,'产品Owner',true);if(!hasRole(owner,'产品'))fail('VALIDATION_ERROR','产品Owner必须选择产品角色用户');next.productOwnerId=owner.id;} if(rule.version){const versionRecord=version(old.projectId,required(input.version,'请选择项目版本','VERSION_REQUIRED'));if(!versionRecord)fail('VERSION_REQUIRED','请选择当前项目的有效版本');next.version=versionRecord.version;next.versionConfirmed=true;next.versionReleaseDate=versionRecord.release_date;} if(rule.release)next.releaseDate=required(input.releaseDate,'请填写发布日期','RELEASE_DATE_REQUIRED'); if(input.action==='terminate')next.terminationReason=norm(input.reason); if(rule.reason)next.returnNotes=[{at:now(),reason:norm(input.reason),stage:old.status==='待预审'?'预审':'初筛',operator:actor.name},...(old.returnNotes||[])]; next.currentHandler=rule.owner?user(next.productOwnerId).name:rule.to==='待评估'?'业务需求质量管理员':rule.to==='待需求方重新评估'?old.requester:['待预审','待投产','产品设计'].includes(rule.to)?'产品经理':rule.to==='研发实施'?'研发负责人':'-';
  const at=now(); persist(next,old,at); const note=rule.reason?norm(input.reason):rule.version?`确认版本：${next.version}；版本发布时间：${next.versionReleaseDate}`:rule.owner?`产品Owner：@${user(next.productOwnerId).name}`:rule.release?next.releaseDate:''; const historyItem={at,operator:actor.name,role:actor.role,action:rule.name,from:old.status,to:rule.to,note}; history(old.id,historyItem); const updated = getRequirement(old.id); notifyWorkflowUpdate(updated, actor, historyItem, at); return updated;
}
function quickReleaseRequirements(input, actor) {
  requireRole(actor, ['产品']);
  const versionId = required(input.projectVersionId, '请选择要发布的版本');
  const versionRecord = db.prepare('SELECT * FROM project_versions WHERE id = ?').get(versionId);
  if (!versionRecord) fail('NOT_FOUND', '项目版本不存在', 404);
  const ids = Array.isArray(input.requirementIds) ? input.requirementIds.filter(Boolean) : [];
  if (!ids.length) fail('VALIDATION_ERROR', '请至少选择一条需求');
  if (new Set(ids).size !== ids.length) fail('VALIDATION_ERROR', '发布清单中存在重复需求');

  const requirements = ids.map((requirementId) => {
    const item = getRequirement(requirementId);
    if (!item) fail('NOT_FOUND', '需求不存在', 404);
    if (item.status !== '研发实施') fail('STATE_CONFLICT', `需求 ${item.code} 当前不在研发实施阶段`, 409);
    if (!item.versionConfirmed || !item.version) fail('STATE_CONFLICT', `需求 ${item.code} 尚未确认项目版本`, 409);
    if (item.projectId !== versionRecord.project_id || String(item.version).toLowerCase() !== String(versionRecord.version).toLowerCase()) fail('VALIDATION_ERROR', `需求 ${item.code} 不属于所选项目版本`);
    return item;
  });

  const at = now();
  const updated = transaction(() => requirements.map((old) => {
    const next = { ...old, status: '完成发布', releaseDate: versionRecord.release_date, versionReleaseDate: versionRecord.release_date, currentHandler: '-' };
    persist(next, old, at);
    const historyItem = {
      at,
      operator: actor.name,
      role: actor.role,
      action: '快速发布',
      from: '研发实施',
      to: '完成发布',
      note: `版本 ${versionRecord.version}；发布日期：${versionRecord.release_date}`
    };
    history(old.id, historyItem);
    const released = getRequirement(old.id); notifyWorkflowUpdate(released, actor, historyItem, at);
    return released;
  }));
  return { count: updated.length, version: publicVersion(versionRecord), requirements: updated };
}
function seed() { const userInsert=db.prepare('INSERT OR IGNORE INTO users(id, name, name_normalized, department, role, status) VALUES (?, ?, ?, ?, ?, ?)'); [['u1','王敏','运营部','业务需求方'],['u2','赵宁','增长部','业务需求质量管理员'],['u3','孙莉','商务部','业务需求方'],['u4','李欣','产品部','产品'],['u5','陈晨','产品部','产品'],['u6','周杰','技术部','研发'],['u7','系统管理员','系统管理部','系统管理员']].forEach(([userId,name,department,role])=>userInsert.run(userId,name,norm(name).toLowerCase(),department,role,'启用')); const projectInsert=db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)'); presetProjects.forEach(({id:projectId,name})=>{const at=now();projectInsert.run(projectId,name,norm(name).toLowerCase(),'导购电商','','启用',at,at);}); if(!db.prepare('SELECT count(*) AS count FROM requirements').get().count){createRequirement({title:'支持抖音电商返现能力',source:'运营',projectId:legacyProjectIds.get('p2'),descriptionHtml:'<p><b>背景</b>：返现业务需要拓展抖音电商场景。</p><p><b>目标</b>：提升渠道订单转化。</p><p><b>需求</b>：支持抖音电商返现。</p>'},getActor('requester','u1'));createRequirement({title:'返还网订单列表体验优化',source:'产品',projectId:legacyProjectIds.get('p3'),descriptionHtml:'<p>优化订单状态筛选与返现到账提示。</p>'},getActor('requester','u3'));} }
migrateLegacyProjectIds(db);
migrateRequesterRoleLabel();
migrateRequirementSources();
migrateProductDesignStatus();
migrateRequirementCodes();
if (process.env.BRMS_SEED !== '0') seed();
migrateUserRoles();
migrateRequesterOwners();
migrateRequirementNoteThreads();
migrateMessageLabels();
migrateHistoryLabels();
reconcileRichTextAssets();

const respond=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(status===204?'':JSON.stringify(data));};
const body=(req,maxBytes=1e6)=>new Promise((resolve,reject)=>{let size=0,raw='',settled=false;const rejectOnce=error=>{if(!settled){settled=true;reject(error);}};req.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){rejectOnce(Object.assign(new Error('请求内容过大'),{code:'PAYLOAD_TOO_LARGE',status:413}));req.resume();return;}raw+=chunk;});req.on('end',()=>{if(settled)return;try{resolve(raw?JSON.parse(raw):{});}catch{rejectOnce(Object.assign(new Error('请求内容不是合法 JSON'),{code:'VALIDATION_ERROR'}));}});req.on('error',rejectOnce);});
const itemId=(pathname,name)=>pathname.match(new RegExp(`^/api/${name}/([^/]+)$`));
const staticTypes={'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon'};
const imageTypes={
  'image/png': { extension: 'png', signature: bytes => bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
  'image/jpeg': { extension: 'jpg', signature: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  'image/webp': { extension: 'webp', signature: bytes => bytes.length >= 12 && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' },
  'image/gif': { extension: 'gif', signature: bytes => bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()) }
};
function saveImageUpload(input, actor) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=]+)$/i.exec(String(input.dataUrl || ''));
  if (!match) fail('VALIDATION_ERROR', '请选择 PNG、JPG、WebP 或 GIF 图片');
  const type = imageTypes[match[1].toLowerCase()];
  const file = Buffer.from(match[2], 'base64');
  if (!file.length || file.length > 5 * 1024 * 1024 || !type.signature(file)) fail('VALIDATION_ERROR', '图片文件无效或超过 5 MB');
  const filename = `${crypto.randomUUID()}.${type.extension}`;
  fs.writeFileSync(path.join(uploadDir, filename), file, { flag: 'wx' });
  const url = `/uploads/${filename}`;
  try { db.prepare('INSERT INTO rich_text_assets(url, filename, uploaded_by, requirement_id, created_at, claimed_at) VALUES (?, ?, ?, NULL, ?, \'\')').run(url, filename, actor.id, now()); } catch (error) { fs.unlinkSync(path.join(uploadDir, filename)); throw error; }
  return { url };
}
function assetIntegrityReport() {
  const assets = db.prepare('SELECT url, filename, uploaded_by, requirement_id, created_at, claimed_at FROM rich_text_assets ORDER BY created_at DESC').all();
  const missing = assets.filter((asset) => !fs.existsSync(path.join(uploadDir, asset.filename)));
  const unclaimed = assets.filter((asset) => !asset.requirement_id);
  return { total: assets.length, claimed: assets.length - unclaimed.length, unclaimed, missing };
}
function serveStatic(req,res,pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname.startsWith('/uploads/')) {
    const filename = pathname.slice('/uploads/'.length);
    if (!/^[a-f0-9-]+\.(?:png|jpe?g|webp|gif)$/i.test(filename)) return false;
    const filePath = path.resolve(uploadDir, filename);
    if (!filePath.startsWith(`${uploadDir}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    res.writeHead(200, {'Content-Type':staticTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=31536000, immutable'});
    if (req.method !== 'HEAD') fs.createReadStream(filePath).pipe(res); else res.end();
    return true;
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(__dirname, requested);
  if (!filePath.startsWith(`${__dirname}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const body = fs.readFileSync(filePath);
  // This is an actively developed single-page application. Serving every UI asset
  // without a freshness delay prevents the page shell and its enhancement scripts
  // from getting out of sync after a deployment.
  res.writeHead(200, {'Content-Type':staticTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
  if (req.method !== 'HEAD') res.end(body); else res.end();
  return true;
}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,`http://${host}:${port}`),actor=getActor(demoAuthEnabled?req.headers['x-brms-demo-role']:undefined,demoAuthEnabled?req.headers['x-brms-demo-user-id']:undefined),{pathname}=url;if(!pathname.startsWith('/api/')&&serveStatic(req,res,pathname))return;try{
  if(req.method==='GET'&&pathname==='/api/health')return respond(res,200,{status:'ok',database:'sqlite',at:now()}); if(req.method==='GET'&&pathname==='/api/me')return respond(res,200,{id:actor.id,name:actor.name,role:actor.key,label:actor.role,roles:actor.roles,permissions:['requirements:read']});
  if(req.method==='POST'&&pathname==='/api/uploads/images')return respond(res,201,saveImageUpload(await body(req,7 * 1024 * 1024),actor));
  if(req.method==='GET'&&pathname==='/api/integrity/rich-text-assets'){requireRole(actor,['系统管理员']);return respond(res,200,assetIntegrityReport());}
  if(req.method==='GET'&&pathname==='/api/workbench')return respond(res,200,workbench(actor,url.searchParams.get('status')||''));
  if(req.method==='GET'&&pathname==='/api/messages')return respond(res,200,messages(actor,Math.min(Math.max(Number(url.searchParams.get('limit')) || 5,1),20)));
  if(req.method==='GET'&&pathname==='/api/requirement-activities')return respond(res,200,requirementActivities(actor,Math.min(Math.max(Number(url.searchParams.get('limit')) || 3,1),20)));
  if(req.method==='POST'&&pathname==='/api/requirement-activities/read-all')return respond(res,200,readAllRequirementActivities(actor));
  const activityMatch=pathname.match(/^\/api\/requirement-activities\/([^/]+)\/read$/);if(activityMatch&&req.method==='POST')return respond(res,200,readRequirementActivity(activityMatch[1],actor));
  if(req.method==='GET'&&pathname==='/api/archives')return respond(res,200,archiveRequirements(actor,norm(url.searchParams.get('keyword'))));
  if(pathname==='/api/users'&&req.method==='GET'){const keyword=norm(url.searchParams.get('keyword')).toLowerCase(),status=url.searchParams.get('status');return respond(res,200,db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser).filter(x=>(!keyword||`${x.name}${x.department}${x.roles.join(' ')}`.toLowerCase().includes(keyword))&&(!status||x.status===status)));}
  if(pathname==='/api/users'&&req.method==='POST'){requireRole(actor,['系统管理员']);const x=await body(req),name=required(x.name,'请填写姓名'),department=required(x.department,'请填写部门'),selectedRoles=normalizedRoles(x.roles ?? x.role),initialPassword=temporaryPassword(),row={id:id(),name,department,role:selectedRoles[0],roles:JSON.stringify(selectedRoles),status:x.status==='停用'?'停用':'启用'};try{db.prepare('INSERT INTO users(id,name,name_normalized,department,role,status,roles,password_hash,password_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id,row.name,norm(name).toLowerCase(),row.department,row.role,row.status,row.roles,passwordHash(initialPassword),now());}catch{fail('VALIDATION_ERROR','用户姓名不能重复');}return respond(res,201,{...publicUser(user(row.id)),initialPassword});}
  const passwordResetMatch=pathname.match(/^\/api\/users\/([^/]+)\/password-reset$/);if(passwordResetMatch&&req.method==='POST'){requireRole(actor,['系统管理员']);const old=user(passwordResetMatch[1]);if(!old)fail('NOT_FOUND','用户不存在',404);const password=temporaryPassword();db.prepare('UPDATE users SET password_hash=?,password_updated_at=? WHERE id=?').run(passwordHash(password),now(),old.id);return respond(res,200,{id:old.id,name:old.name,password});}
  const userMatch=itemId(pathname,'users');if(userMatch&&req.method==='PATCH'){requireRole(actor,['系统管理员']);const old=user(userMatch[1]);if(!old)fail('NOT_FOUND','用户不存在',404);const x=await body(req),name=required(x.name??old.name,'请填写姓名'),department=required(x.department??old.department,'请填写部门'),selectedRoles=normalizedRoles(x.roles ?? x.role ?? userRoles(old));try{db.prepare('UPDATE users SET name=?,name_normalized=?,department=?,role=?,roles=?,status=? WHERE id=?').run(name,norm(name).toLowerCase(),department,selectedRoles[0],JSON.stringify(selectedRoles),x.status==='停用'?'停用':'启用',old.id);}catch{fail('VALIDATION_ERROR','用户姓名不能重复');}return respond(res,200,publicUser(user(old.id)));}if(userMatch&&req.method==='DELETE'){requireRole(actor,['系统管理员']);const old=user(userMatch[1]);if(!old)fail('NOT_FOUND','用户不存在',404);const used=db.prepare('SELECT payload FROM requirements').all().some(row=>{const payload=parse(row.payload);return payload.productOwnerId===old.id||payload.requesterOwnerId===old.id||payload.requester===old.name;});if(used)fail('USER_REFERENCED','该用户已被需求引用，不能删除');db.prepare('DELETE FROM users WHERE id=?').run(old.id);return respond(res,204);}
  if(pathname==='/api/projects'&&req.method==='GET')return respond(res,200,db.prepare('SELECT * FROM projects ORDER BY id ASC').all().map(publicProject));if(pathname==='/api/projects'&&req.method==='POST'){requireRole(actor,['系统管理员']);const x=await body(req),name=required(x.name,'请填写项目名称'),projectType=required(x.projectType,'请填写项目类型'),at=now(),projectId=id();try{db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(projectId,name,norm(name).toLowerCase(),projectType,norm(x.description),x.status==='停用'?'停用':'启用',at,at);}catch{fail('PROJECT_NAME_CONFLICT','项目名称不能重复');}return respond(res,201,publicProject(project(projectId)));}
  const projectMatch=itemId(pathname,'projects');if(projectMatch&&req.method==='GET'){const old=project(projectMatch[1]);if(!old)fail('NOT_FOUND','项目不存在',404);return respond(res,200,publicProject(old));}if(projectMatch&&req.method==='PATCH'){requireRole(actor,['系统管理员']);const old=project(projectMatch[1]);if(!old)fail('NOT_FOUND','项目不存在',404);const x=await body(req),name=required(x.name??old.name,'请填写项目名称'),projectType=required(x.projectType??old.project_type,'请填写项目类型');try{db.prepare('UPDATE projects SET name=?,name_normalized=?,project_type=?,description=?,status=?,updated_at=? WHERE id=?').run(name,norm(name).toLowerCase(),projectType,norm(x.description??old.description),x.status==='停用'?'停用':'启用',now(),old.id);}catch{fail('PROJECT_NAME_CONFLICT','项目名称不能重复');}return respond(res,200,publicProject(project(old.id)));}if(projectMatch&&req.method==='DELETE'){requireRole(actor,['系统管理员']);const old=project(projectMatch[1]);if(!old)fail('NOT_FOUND','项目不存在',404);if(db.prepare('SELECT 1 FROM requirements WHERE project_id=? LIMIT 1').get(old.id)||db.prepare('SELECT 1 FROM project_versions WHERE project_id=? LIMIT 1').get(old.id))fail('PROJECT_REFERENCED','该项目已被业务需求或版本引用，不能删除');db.prepare('DELETE FROM projects WHERE id=?').run(old.id);return respond(res,204);}
  if(pathname==='/api/project-versions'&&req.method==='GET'){const projectId=url.searchParams.get('projectId'),rows=projectId?db.prepare('SELECT * FROM project_versions WHERE project_id=? ORDER BY release_date DESC').all(projectId):db.prepare('SELECT * FROM project_versions ORDER BY release_date DESC').all();return respond(res,200,rows.map(publicVersion));}if(pathname==='/api/project-versions'&&req.method==='POST'){requireRole(actor,['系统管理员']);const x=await body(req);if(!project(x.projectId))fail('NOT_FOUND','项目不存在',404);const versionName=required(x.version,'请填写版本号'),releaseDate=required(x.releaseDate,'请填写版本发布时间'),at=now(),versionId=id();try{db.prepare('INSERT INTO project_versions VALUES (?, ?, ?, ?, ?, ?)').run(versionId,x.projectId,versionName,releaseDate,at,at);}catch{fail('VALIDATION_ERROR','该项目下的版本号已存在');}return respond(res,201,publicVersion(db.prepare('SELECT * FROM project_versions WHERE id=?').get(versionId)));}
  const versionMatch=itemId(pathname,'project-versions');if(versionMatch&&req.method==='PATCH'){requireRole(actor,['系统管理员']);const old=db.prepare('SELECT * FROM project_versions WHERE id=?').get(versionMatch[1]);if(!old)fail('NOT_FOUND','项目版本不存在',404);const x=await body(req),projectId=x.projectId??old.project_id;if(!project(projectId))fail('NOT_FOUND','项目不存在',404);try{db.prepare('UPDATE project_versions SET project_id=?,version=?,release_date=?,updated_at=? WHERE id=?').run(projectId,required(x.version??old.version,'请填写版本号'),required(x.releaseDate??old.release_date,'请填写版本发布时间'),now(),old.id);}catch{fail('VALIDATION_ERROR','该项目下的版本号已存在');}return respond(res,200,publicVersion(db.prepare('SELECT * FROM project_versions WHERE id=?').get(old.id)));}if(versionMatch&&req.method==='DELETE'){requireRole(actor,['系统管理员']);const old=db.prepare('SELECT * FROM project_versions WHERE id=?').get(versionMatch[1]);if(!old)fail('NOT_FOUND','项目版本不存在',404);if(db.prepare('SELECT 1 FROM requirements WHERE project_id=? AND lower(version)=lower(?) LIMIT 1').get(old.project_id,old.version))fail('PROJECT_VERSION_REFERENCED','当前版本已被使用，不允许删除');db.prepare('DELETE FROM project_versions WHERE id=?').run(old.id);return respond(res,204);}
  if(pathname==='/api/requirements'&&req.method==='GET'){const filters={keyword:norm(url.searchParams.get('keyword')),projectId:queryValues(url.searchParams,'projectId'),status:queryValues(url.searchParams,'status'),source:queryValues(url.searchParams,'source'),requesterOwnerId:queryValues(url.searchParams,'requesterOwnerId'),returnedByMe:url.searchParams.get('returnedByMe')==='true'},direction=url.searchParams.get('sortOrder')==='asc'?1:-1,sort=url.searchParams.get('sortBy')==='createdAt'?'createdAt':'updatedAt',matches=(values,value)=>!values.length||values.includes(value);const items=db.prepare('SELECT * FROM requirements').all().map(requirement).filter(x=>canReadRequirement(actor,x)).filter(x=>(!filters.returnedByMe||wasReturnedBy(x,actor))&&(!filters.keyword||`${x.code}${x.title}`.toLowerCase().includes(filters.keyword.toLowerCase()))&&matches(filters.projectId,x.projectId)&&matches(filters.status,x.status)&&matches(filters.source,x.source)&&matches(filters.requesterOwnerId,x.requesterOwnerId)).filter(x=>(!url.searchParams.get('createdFrom')||x.createdAt>=url.searchParams.get('createdFrom'))&&(!url.searchParams.get('createdTo')||x.createdAt<=`${url.searchParams.get('createdTo')}T23:59:59.999Z`)).sort((a,b)=>String(a[sort]).localeCompare(String(b[sort]))*direction);return respond(res,200,items);}if(pathname==='/api/requirements'&&req.method==='POST')return respond(res,201,createRequirement(await body(req),actor));
  if(pathname==='/api/requirements/quick-release'&&req.method==='POST')return respond(res,200,quickReleaseRequirements(await body(req),actor));
  const requirementMatch=pathname.match(/^\/api\/requirements\/([^/]+)(?:\/(actions|history))?$/);if(requirementMatch&&req.method==='GET'){const x=getRequirement(requirementMatch[1]);if(!x)fail('NOT_FOUND','需求不存在',404);if(!canReadArchiveRequirement(actor,x))fail('FORBIDDEN','无权查看该需求',403);return respond(res,200,requirementMatch[2]==='history'?x.history:x);}if(requirementMatch&&!requirementMatch[2]&&req.method==='PATCH')return respond(res,200,updateRequirement(requirementMatch[1],await body(req),actor));if(requirementMatch?.[2]==='actions'&&req.method==='POST')return respond(res,200,actionRequirement(requirementMatch[1],await body(req),actor));return respond(res,404,{code:'NOT_FOUND',message:'接口不存在'});
}catch(err){return respond(res,err.status||(err.code==='FORBIDDEN'?403:422),{code:err.code||'VALIDATION_ERROR',message:err.message||'请求处理失败'});}});
server.listen(port,host,()=>console.log(`BRMS is listening on http://${host}:${port}/ (API: /api, database: ${databasePath})`));

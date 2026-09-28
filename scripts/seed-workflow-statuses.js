/* Adds one representative requirement for every workflow state missing from the local demo database. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pinyin } = require('pinyin-pro');

const databasePath = process.env.BRMS_DB_PATH || path.join(__dirname, '..', 'data', 'brms.sqlite');
if (!fs.existsSync(databasePath)) throw new Error(`未找到本地数据库：${databasePath}`);

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON;');
const requirementColumns = db.prepare('PRAGMA table_info(requirements)').all().map((column) => column.name);
if (!requirementColumns.includes('archived_at')) db.exec("ALTER TABLE requirements ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''");

const fixtures = [
  { status: '待需求方重新评估', projectName: '返现', title: '返现活动报名条件补充', source: '运营', requester: '王敏', requesterOwnerId: 'u1', productOwnerId: '', currentHandler: '王敏', returnReason: '请补充活动报名门槛与异常处理范围。' },
  { status: '待预审', projectName: '返还网', title: '返还网订单售后状态优化', source: '产品', requester: '孙莉', requesterOwnerId: 'u3', productOwnerId: '', currentHandler: '产品经理' },
  { status: '待投产', projectName: '柚省业务', title: '柚省频道页商品标签展示', source: '设计', requester: '王敏', requesterOwnerId: 'u1', productOwnerId: 'u4', currentHandler: '李欣' },
  { status: '研发实施', projectName: '柚子街', title: '柚子街优惠券核销接口升级', source: '研发', requester: '孙莉', requesterOwnerId: 'u3', productOwnerId: 'u5', currentHandler: '研发负责人', version: '2026.10.0', versionReleaseDate: '2026-10-20' },
  { status: '需求撤销', projectName: '羊毛省钱', title: '羊毛省钱入口文案调整', source: '运营', requester: '王敏', requesterOwnerId: 'u1', productOwnerId: '', currentHandler: '-' },
  { status: '需求终止', projectName: '返现', title: '返现会员积分联动方案', source: '商务合作', requester: '孙莉', requesterOwnerId: 'u3', productOwnerId: 'u4', currentHandler: '-', terminationReason: '合作方接口能力调整，当前方案无法满足上线条件。' }
];

const at = '2026-09-26T09:00:00.000Z';
const insertRequirement = db.prepare(`
  INSERT INTO requirements(id, code, project_id, payload, status, version, version_confirmed, release_date, archived_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertHistory = db.prepare('INSERT INTO requirement_histories(id, requirement_id, payload, created_at) VALUES (?, ?, ?, ?)');
const insertVersion = db.prepare(`
  INSERT INTO project_versions(id, project_id, version, release_date, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(project_id, version) DO NOTHING
`);
const listProjectCodes = db.prepare('SELECT code FROM requirements WHERE project_id = ?');
const upsertSequence = db.prepare(`
  INSERT INTO requirement_sequences(project_id, next_sequence) VALUES (?, ?)
  ON CONFLICT(project_id) DO UPDATE SET next_sequence = excluded.next_sequence
`);

function projectInitials(name) {
  const normalizedName = String(name || '').replace(/业务|app/gi, '');
  return pinyin(normalizedName, { pattern: 'first', toneType: 'none', type: 'array' })
    .map((letter) => String(letter).toUpperCase())
    .filter((letter) => /^[A-Z]$/.test(letter))
    .join('')
    .slice(0, 4) || 'WLX';
}

function nextCode(project) {
  const prefix = `${projectInitials(project.name)}-`;
  const pattern = new RegExp(`^${prefix}(\\d{3,})$`);
  const maxSequence = listProjectCodes.all(project.id)
    .reduce((max, row) => Math.max(max, Number(row.code.match(pattern)?.[1] || 0)), 0);
  const sequence = maxSequence + 1;
  upsertSequence.run(project.id, sequence + 1);
  return `${prefix}${String(sequence).padStart(3, '0')}`;
}

function addHistory(requirementId, action, from, to, operator, role, note = '', offset = 0) {
  const time = new Date(Date.parse(at) + offset * 60_000).toISOString();
  insertHistory.run(crypto.randomUUID(), requirementId, JSON.stringify({ at: time, action, from, to, operator, role, note }), time);
}

function historyFor(item, requirementId) {
  addHistory(requirementId, '发起需求', '-', '待评估', item.requester, '业务需求方', '', 0);
  if (item.status === '待需求方重新评估') {
    addHistory(requirementId, '初筛退回', '待评估', item.status, '赵宁', '业务需求质量管理员', item.returnReason, 1);
  } else if (item.status === '待预审') {
    addHistory(requirementId, '初筛通过', '待评估', item.status, '赵宁', '业务需求质量管理员', '需求信息完整，进入预审。', 1);
  } else if (item.status === '待投产') {
    addHistory(requirementId, '初筛通过', '待评估', '待预审', '赵宁', '业务需求质量管理员', '', 1);
    addHistory(requirementId, '预审通过并分配产品Owner', '待预审', item.status, '系统管理员', '系统管理员', '产品Owner：@李欣', 2);
  } else if (item.status === '研发实施') {
    addHistory(requirementId, '初筛通过', '待评估', '待预审', '赵宁', '业务需求质量管理员', '', 1);
    addHistory(requirementId, '预审通过并分配产品Owner', '待预审', '待投产', '系统管理员', '系统管理员', '产品Owner：@陈晨', 2);
    addHistory(requirementId, '开始产品设计', '待投产', '产品设计', '陈晨', '产品', `确认版本：${item.version}；版本发布时间：${item.versionReleaseDate}`, 3);
    addHistory(requirementId, '开始研发实施', '产品设计', item.status, '陈晨', '产品', '', 4);
  } else if (item.status === '需求撤销') {
    addHistory(requirementId, '撤销需求', '待评估', item.status, item.requester, '业务需求方', '', 1);
  } else if (item.status === '需求终止') {
    addHistory(requirementId, '初筛通过', '待评估', '待预审', '赵宁', '业务需求质量管理员', '', 1);
    addHistory(requirementId, '预审通过并分配产品Owner', '待预审', '待投产', '系统管理员', '系统管理员', '产品Owner：@李欣', 2);
    addHistory(requirementId, '终止需求', '待投产', item.status, '李欣', '产品', item.terminationReason, 3);
  }
}

let inserted = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const item of fixtures) {
    if (db.prepare('SELECT 1 FROM requirements WHERE status = ? LIMIT 1').get(item.status)) continue;
    const project = db.prepare('SELECT id, name FROM projects WHERE name = ?').get(item.projectName);
    if (!project) throw new Error(`缺少演示项目：${item.projectName}`);
    const requirementId = crypto.randomUUID();
    if (item.version) insertVersion.run(`demo-version-${item.version}`, project.id, item.version, item.versionReleaseDate, at, at);
    const payload = {
      title: item.title,
      source: item.source,
      descriptionHtml: `<p>${item.title}，用于验证“${item.status}”状态在需求列表中的筛选、展示与流转操作。</p>`,
      requesterNoteHtml: '',
      implementationNoteHtml: '',
      engineeringNoteHtml: '',
      requester: item.requester,
      requesterOwnerId: item.requesterOwnerId,
      productOwnerId: item.productOwnerId,
      terminationReason: item.terminationReason || '',
      returnNotes: item.returnReason ? [{ at, reason: item.returnReason, stage: '初筛', operator: '赵宁' }] : [],
      currentHandler: item.currentHandler,
      versionReleaseDate: item.versionReleaseDate || ''
    };
    insertRequirement.run(requirementId, nextCode(project), project.id, JSON.stringify(payload), item.status, item.version || '', item.version ? 1 : 0, '', '', at, at);
    historyFor(item, requirementId);
    inserted += 1;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}

console.log(`已补充 ${inserted} 条缺失状态演示需求，数据库：${databasePath}`);

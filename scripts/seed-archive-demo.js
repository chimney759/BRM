/* Inserts repeatable, archive-eligible demo records into the local SQLite database. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.BRMS_DB_PATH || path.join(__dirname, '..', 'data', 'brms.sqlite');
if (!fs.existsSync(databasePath)) throw new Error(`未找到本地数据库：${databasePath}`);

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON;');

const archiveItems = [
  { id: 'demo-archive-fx-001', code: 'FX-003', projectName: '返现业务', versionId: 'demo-version-fx-860', version: '8.6.0', versionReleaseDate: '2026-02-18', releaseDate: '2026-02-22', createdAt: '2026-01-08T09:30:00.000Z', source: '运营', title: '返现活动页转化链路优化', requesterOwnerId: 'u1', productOwnerId: 'u4', requester: '王敏' },
  { id: 'demo-archive-fx-002', code: 'FX-004', projectName: '返现业务', versionId: 'demo-version-fx-860', version: '8.6.0', versionReleaseDate: '2026-02-18', releaseDate: '2026-02-22', createdAt: '2026-01-12T10:15:00.000Z', source: '研发', title: '返现订单回调监控补强', requesterOwnerId: 'u1', productOwnerId: 'u5', requester: '王敏' },
  { id: 'demo-archive-fhw-001', code: 'FHW-002', projectName: '返还网业务', versionId: 'demo-version-fhw-6120', version: '6.12.0', versionReleaseDate: '2026-01-20', releaseDate: '2026-01-26', createdAt: '2025-12-18T09:40:00.000Z', source: '用户反馈', title: '返还网订单到账提醒优化', requesterOwnerId: 'u3', productOwnerId: 'u4', requester: '孙莉' },
  { id: 'demo-archive-fhw-002', code: 'FHW-003', projectName: '返还网业务', versionId: 'demo-version-fhw-6120', version: '6.12.0', versionReleaseDate: '2026-01-20', releaseDate: '2026-01-26', createdAt: '2025-12-23T14:20:00.000Z', source: '商务合作', title: '返还网合作渠道商品标识支持', requesterOwnerId: 'u3', productOwnerId: 'u5', requester: '孙莉' },
  { id: 'demo-archive-ys-001', code: 'YS-001', projectName: '柚省业务', versionId: 'demo-version-ys-590', version: '5.9.0', versionReleaseDate: '2025-12-12', releaseDate: '2025-12-18', createdAt: '2025-11-17T11:00:00.000Z', source: '设计', title: '柚省首页信息层级调整', requesterOwnerId: 'u1', productOwnerId: 'u4', requester: '王敏' }
];

const historyId = () => crypto.randomUUID();
const insertVersion = db.prepare(`
  INSERT INTO project_versions(id, project_id, version, release_date, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(project_id, version) DO UPDATE SET release_date = excluded.release_date, updated_at = excluded.updated_at
`);
const findRequirement = db.prepare('SELECT id FROM requirements WHERE code = ?');
const insertRequirement = db.prepare(`
  INSERT INTO requirements(id, code, project_id, payload, status, version, version_confirmed, release_date, created_at, updated_at)
  VALUES (?, ?, ?, ?, '完成发布', ?, 1, ?, ?, ?)
`);
const updateRequirement = db.prepare(`
  UPDATE requirements SET project_id = ?, payload = ?, status = '完成发布', version = ?, version_confirmed = 1,
  release_date = ?, created_at = ?, updated_at = ? WHERE id = ?
`);
const clearHistory = db.prepare('DELETE FROM requirement_histories WHERE requirement_id = ?');
const insertHistory = db.prepare('INSERT INTO requirement_histories(id, requirement_id, payload, created_at) VALUES (?, ?, ?, ?)');

function payloadFor(item) {
  return {
    title: item.title,
    source: item.source,
    descriptionHtml: `<p>${item.title}已完成方案评审、研发实施和发布验证，用于校验归档展示。</p>`,
    requesterNoteHtml: '<p>请在版本发布后关注关键指标表现。</p>',
    implementationNoteHtml: '<p>已完成联调、验收与上线复盘。</p>',
    engineeringNoteHtml: '<p>发布后运行稳定，监控指标正常。</p>',
    requester: item.requester,
    requesterOwnerId: item.requesterOwnerId,
    productOwnerId: item.productOwnerId,
    terminationReason: '',
    returnNotes: [],
    currentHandler: '-',
    versionReleaseDate: item.versionReleaseDate
  };
}

function addHistory(requirementId, at, action, from, to, note, operator, role) {
  insertHistory.run(historyId(), requirementId, JSON.stringify({ at, action, from, to, note, operator, role }), at);
}

db.exec('BEGIN IMMEDIATE');
try {
  for (const item of archiveItems) {
    const project = db.prepare('SELECT id FROM projects WHERE name = ?').get(item.projectName);
    if (!project) throw new Error(`缺少演示项目：${item.projectName}`);
    const projectId = project.id;
    const versionCreatedAt = `${item.versionReleaseDate}T08:00:00.000Z`;
    insertVersion.run(item.versionId, projectId, item.version, item.versionReleaseDate, versionCreatedAt, versionCreatedAt);

    const payload = JSON.stringify(payloadFor(item));
    const existing = findRequirement.get(item.code);
    const requirementId = existing?.id || item.id;
    if (existing) updateRequirement.run(projectId, payload, item.version, item.releaseDate, item.createdAt, `${item.releaseDate}T16:00:00.000Z`, requirementId);
    else insertRequirement.run(requirementId, item.code, projectId, payload, item.version, item.releaseDate, item.createdAt, `${item.releaseDate}T16:00:00.000Z`);

    clearHistory.run(requirementId);
    addHistory(requirementId, item.createdAt, '发起需求', '-', '待评估', '', item.requester, '业务需求方');
    addHistory(requirementId, `${item.versionReleaseDate}T09:00:00.000Z`, '初筛通过', '待评估', '待预审', '需求信息完整，进入预审。', '赵宁', '业务需求质量管理员');
    addHistory(requirementId, `${item.versionReleaseDate}T10:00:00.000Z`, '预审通过并分配产品Owner', '待预审', '待投产', `产品Owner：@${item.productOwnerId === 'u4' ? '李欣' : '陈晨'}`, '李欣', '产品');
    addHistory(requirementId, `${item.versionReleaseDate}T11:00:00.000Z`, '开始产品设计', '待投产', '产品设计', `确认版本：${item.version}；版本发布时间：${item.versionReleaseDate}`, '李欣', '产品');
    addHistory(requirementId, `${item.versionReleaseDate}T14:00:00.000Z`, '开始研发实施', '产品设计', '研发实施', '设计方案已完成评审。', '李欣', '产品');
    addHistory(requirementId, `${item.releaseDate}T16:00:00.000Z`, '完成发布', '研发实施', '完成发布', item.releaseDate, '李欣', '产品');
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}

console.log(`已写入 ${archiveItems.length} 条可归档演示需求，数据库：${databasePath}`);

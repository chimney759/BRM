/* Replaces legacy display-like project identifiers with UUID primary keys. */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.BRMS_DB_PATH || path.join(__dirname, '..', 'data', 'brms.sqlite');
const legacyProjectIds = new Map([
  ['p1', '0d7d6f8d-64c0-4a5e-8ab1-2a9c2fc10b01'],
  ['p2', '4ebef454-991e-4ac7-9802-0cedb2ec4702'],
  ['p3', '67ed1049-a2a3-4a3c-98c2-6231f0b92803'],
  ['p4', 'a792bc31-a7bb-4c86-8a51-56e028079904'],
  ['p5', 'cd9569d7-36e2-4171-8b49-1e57499e0c05']
]);

function migrateLegacyProjectIds(db) {
  const existing = new Set(db.prepare('SELECT id FROM projects').all().map((row) => row.id));
  const changes = [...legacyProjectIds].filter(([legacyId]) => existing.has(legacyId));
  if (!changes.length) return 0;

  // SQLite does not support ON UPDATE CASCADE on the original schema. Updating
  // dependent records before their project rows keeps all references intact.
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE');
  try {
    const updateVersions = db.prepare('UPDATE project_versions SET project_id = ? WHERE project_id = ?');
    const updateRequirements = db.prepare('UPDATE requirements SET project_id = ? WHERE project_id = ?');
    const updateSequences = db.prepare('UPDATE requirement_sequences SET project_id = ? WHERE project_id = ?');
    const updateProjects = db.prepare('UPDATE projects SET id = ? WHERE id = ?');
    for (const [legacyId, uuid] of changes) {
      updateVersions.run(uuid, legacyId);
      updateRequirements.run(uuid, legacyId);
      updateSequences.run(uuid, legacyId);
      updateProjects.run(uuid, legacyId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }

  const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyErrors.length) throw new Error('项目 ID 迁移后检测到外键引用异常');
  return changes.length;
}

if (require.main === module) {
  if (!fs.existsSync(databasePath)) throw new Error(`未找到本地数据库：${databasePath}`);
  const db = new DatabaseSync(databasePath);
  try {
    console.log(`已迁移 ${migrateLegacyProjectIds(db)} 个项目 ID，数据库：${databasePath}`);
  } finally {
    db.close();
  }
}

module.exports = { legacyProjectIds, migrateLegacyProjectIds };

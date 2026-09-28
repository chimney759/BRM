/* Converts legacy requirement source values to the canonical stored enum. */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.BRMS_DB_PATH || path.join(__dirname, '..', 'data', 'brms.sqlite');
const sourceValueMigration = Object.freeze({
  '运营需求': '运营',
  '产品需求': '产品',
  '技术需求': '研发',
  '设计需求': '设计',
  '安全需求': '安全合规',
  '客户反馈': '用户反馈',
  '商务合作': '商务合作'
});

if (!fs.existsSync(databasePath)) throw new Error(`未找到本地数据库：${databasePath}`);

const db = new DatabaseSync(databasePath);
const update = db.prepare('UPDATE requirements SET payload = ? WHERE id = ?');
let migrated = 0;

db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('SELECT id, payload FROM requirements').all().forEach((row) => {
    const payload = JSON.parse(row.payload || '{}');
    const source = sourceValueMigration[payload.source];
    if (!source || source === payload.source) return;
    payload.source = source;
    update.run(JSON.stringify(payload), row.id);
    migrated += 1;
  });
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}

console.log(`已迁移 ${migrated} 条需求来源记录，数据库：${databasePath}`);

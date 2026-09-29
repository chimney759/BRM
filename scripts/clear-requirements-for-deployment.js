const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.BRMS_DB_PATH || path.join(__dirname, '..', 'data', 'brms.sqlite');
if (!fs.existsSync(databasePath)) throw Error(`数据库不存在：${databasePath}`);

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
try {
  const count = db.prepare('SELECT count(*) AS count FROM requirements').get().count;
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM rich_text_assets').run();
  db.prepare('DELETE FROM requirements').run();
  db.prepare('DELETE FROM requirement_sequences').run();
  db.exec('COMMIT;');
  console.log(JSON.stringify({ clearedRequirements: count, resetRequirementSequences: true }));
} catch (error) {
  db.exec('ROLLBACK;');
  throw error;
}

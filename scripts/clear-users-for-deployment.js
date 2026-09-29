const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.BRMS_DB_PATH || path.join(__dirname, '..', 'data', 'brms.sqlite');
if (!fs.existsSync(databasePath)) throw Error(`数据库不存在：${databasePath}`);

const db = new DatabaseSync(databasePath);
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
if (!userColumns.includes('force_password_change')) db.exec('ALTER TABLE users ADD COLUMN force_password_change INTEGER NOT NULL DEFAULT 0');
db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
try {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM users').run();
  db.exec('COMMIT;');
} catch (error) {
  db.exec('ROLLBACK;');
  throw error;
}

console.log(JSON.stringify({ clearedUsers: true }));

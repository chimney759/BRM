const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.BRMS_DB_PATH || path.join(__dirname, '..', 'data', 'brms.sqlite');
if (!fs.existsSync(databasePath)) throw Error(`数据库不存在：${databasePath}`);

const adminPassword = process.env.BRMS_ADMIN_PASSWORD;
if (!adminPassword) {
  throw Error('请设置 BRMS_ADMIN_PASSWORD 后再执行。');
}

const passwordHash = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
};
const now = new Date().toISOString();
const accounts = [
  {
    id: 'deployment-admin',
    name: 'Admin',
    department: '系统管理',
    role: '系统管理员',
    roles: ['系统管理员'],
    password: adminPassword
  }
];

const db = new DatabaseSync(databasePath);
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
if (!userColumns.includes('force_password_change')) db.exec('ALTER TABLE users ADD COLUMN force_password_change INTEGER NOT NULL DEFAULT 0');
db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
try {
  const upsert = db.prepare(`
    INSERT INTO users(
      id, name, name_normalized, department, role, status, roles,
      password_hash, password_updated_at, failed_login_count, login_locked_until, force_password_change
    ) VALUES (?, ?, ?, ?, ?, '启用', ?, ?, ?, 0, '', 1)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      name_normalized=excluded.name_normalized,
      department=excluded.department,
      role=excluded.role,
      status='启用',
      roles=excluded.roles,
      password_hash=excluded.password_hash,
      password_updated_at=excluded.password_updated_at,
      failed_login_count=0,
      login_locked_until='',
      force_password_change=1
  `);
  const clearSessions = db.prepare('DELETE FROM sessions WHERE user_id=?');
  for (const account of accounts) {
    clearSessions.run(account.id);
    upsert.run(
      account.id,
      account.name,
      account.name.toLowerCase(),
      account.department,
      account.role,
      JSON.stringify(account.roles),
      passwordHash(account.password),
      now
    );
  }
  db.exec('COMMIT;');
} catch (error) {
  db.exec('ROLLBACK;');
  throw error;
}

console.log(JSON.stringify({ provisionedAccounts: accounts.map(({ name, role }) => ({ name, role })) }));

#!/usr/bin/env node
/**
 * Create a user in the RangerAI MySQL database.
 * Usage: node create-user.mjs <username> <password> [displayName] [role]
 * v2.0.0 — Uses db-adapter.mjs (MySQL) instead of direct SQLite
 */
import { logger } from './lib/logger.mjs';
import crypto from 'crypto';
import { initAdapter } from './db-adapter.mjs';

const username = process.argv[2];
const password = process.argv[3];
const displayName = process.argv[4] || username;
const role = process.argv[5] || 'admin';

if (!username || !password) {
  logger.error('Usage: node create-user.mjs <username> <password> [displayName] [role]');
  process.exit(1);
}

async function main() {
  const db = await initAdapter({ type: 'mysql' });

  // Check if user already exists
  const existing = await db.queryOne('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) {
    logger.info(`User "${username}" already exists (id: ${existing.id}). Updating password...`);
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    await db.run('UPDATE users SET passwordHash = ?, salt = ?, displayName = ?, role = ? WHERE id = ?',
      [hash, salt, displayName, role, existing.id]);
    logger.info(`Password updated for user "${username}".`);
  } else {
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');

    await db.run(
      `INSERT INTO users (id, username, passwordHash, salt, displayName, role)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, username, hash, salt, displayName, role]
    );

    logger.info(`User created successfully:`);
    logger.info(`  ID: ${id}`);
    logger.info(`  Username: ${username}`);
    logger.info(`  Display Name: ${displayName}`);
    logger.info(`  Role: ${role}`);
  }

  // List all users
  const users = await db.query('SELECT id, username, displayName, role, isActive, createdAt FROM users');
  logger.info(`\nAll users (${users.length}):`);
  for (const u of users) {
    logger.info(`  - ${u.username} (${u.role}) [${u.isActive ? 'active' : 'disabled'}] created: ${u.createdAt}`);
  }

  await db.close();
}

main().catch(err => {
  logger.error('Error:', err.message);
  process.exit(1);
});

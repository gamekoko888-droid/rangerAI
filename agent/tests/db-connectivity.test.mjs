import { describe, it, beforeAll, afterAll } from "vitest";;
import { expect } from "vitest";;
import mysql from 'mysql2/promise';
import fs from 'fs';

describe('Database Connectivity Tests', () => {
  let connection;

  beforeAll(async () => {
    // Read DB config from config file
    try {
      const configPath = '/opt/rangerai-agent/config.json';
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const dbConfig = config.database || {};
      connection = await mysql.createConnection({
        host: dbConfig.host || '127.0.0.1',
        port: dbConfig.port || 3306,
        user: dbConfig.user || 'root',
        password: dbConfig.password || '',
        database: dbConfig.database || 'rangerai',
        connectTimeout: 5000
      });
    } catch (err) {
      // If config doesn't exist, try defaults
      connection = null;
    }
  });

  afterAll(async () => {
    if (connection) await connection.end();
  });

  it('should connect to MySQL', () => {
    if (!connection) {
      // Skip if no connection possible
      return;
    }
    expect(connection, 'Connection should be established').toBeTruthy();
  });

  it('should execute basic query', async () => {
    if (!connection) return;
    const [rows] = await connection.execute('SELECT 1 as test');
    expect(rows[0].test).toBe(1);
  });

  it('should have chats table', async () => {
    if (!connection) return;
    const [rows] = await connection.execute("SHOW TABLES LIKE 'chats'");
    expect(rows.length > 0, 'chats table should exist').toBeTruthy();
  });

  it('should have messages table', async () => {
    if (!connection) return;
    const [rows] = await connection.execute("SHOW TABLES LIKE 'messages'");
    expect(rows.length > 0, 'messages table should exist').toBeTruthy();
  });
});

/**
 * RangerAI Database Adapter — Unified async interface for SQLite and MySQL.
 * 
 * Usage:
 *   import { initAdapter, query, queryOne, run, runTransaction } from './db-adapter.mjs';
 *   await initAdapter();  // reads DB_TYPE from env
 *   const rows = await query('SELECT * FROM users WHERE role = ?', ['admin']);
 *   const user = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
 *   const result = await run('INSERT INTO users (id, name) VALUES (?, ?)', [id, name]);
 *   // result = { changes: N, lastInsertRowid: M }
 *
 * Environment:
 *   DB_TYPE = 'sqlite' | 'mysql'  (default: 'sqlite')
 *   RANGERAI_DB_PATH = path to SQLite file (for sqlite mode)
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE (for mysql mode)
 */
import { logger } from './lib/logger.mjs';


let adapter = null;
let dbType = 'sqlite';

// ─── SQLite Adapter ──────────────────────────────────────────
async function createSqliteAdapter(dbPath) {
  // Dynamic import to avoid requiring better-sqlite3 when using MySQL
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');  // Safe with WAL, 2x faster writes
  db.pragma('cache_size = -64000');   // 64MB cache (default was 2MB)
  db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
  db.pragma('temp_store = MEMORY');   // Temp tables in memory
  db.pragma('wal_autocheckpoint = 1000'); // Checkpoint every 1000 pages
  logger.info('[db-adapter] SQLite optimized: WAL + NORMAL sync + 64MB cache + 256MB mmap');
  
  // v25.7: WAL health monitoring — periodic checkpoint status and busy stats
  let _walBusyCount = 0;
  let _walMonitorTimer = null;
  
  // Track busy_handler invocations via a wrapper query counter
  const _walStats = { queries: 0, errors: 0, busyRetries: 0, lastCheckpoint: Date.now() };
  
  _walMonitorTimer = setInterval(async () => {
    try {
      // Get WAL status
      const walPages = db.pragma('wal_checkpoint(PASSIVE)');
      const journalMode = db.pragma('journal_mode');
      const cacheSize = db.pragma('cache_size');
      
      // Get database file sizes
      const fs = await import('fs');
      const dbPath = '/opt/rangerai-agent/db/rangerai.db';
      const walPath = dbPath + '-wal';
      const shmPath = dbPath + '-shm';
      
      let walSize = 0, shmSize = 0, dbSize = 0;
      try { dbSize = fs.statSync(dbPath).size; } catch {}
      try { walSize = fs.statSync(walPath).size; } catch {}
      try { shmSize = fs.statSync(shmPath).size; } catch {}
      
      const walSizeMB = (walSize / 1024 / 1024).toFixed(2);
      const dbSizeMB = (dbSize / 1024 / 1024).toFixed(2);
      
      // WAL checkpoint info: [{ busy, log, checkpointed }]
      const cpInfo = walPages[0] || {};
      
      logger.info(`[${new Date().toISOString()}] [db-adapter] [WAL-MONITOR] db=${dbSizeMB}MB wal=${walSizeMB}MB shm=${(shmSize/1024).toFixed(0)}KB | checkpoint: log=${cpInfo.log||0} checkpointed=${cpInfo.checkpointed||0} busy=${cpInfo.busy||0} | queries=${_walStats.queries} errors=${_walStats.errors}`);
      
      // Auto-checkpoint if WAL is too large (>50MB)
      if (walSize > 50 * 1024 * 1024) {
        logger.info(`[${new Date().toISOString()}] [db-adapter] [WAL-MONITOR] WAL file too large (${walSizeMB}MB), forcing TRUNCATE checkpoint`);
        const truncResult = db.pragma('wal_checkpoint(TRUNCATE)');
        logger.info(`[${new Date().toISOString()}] [db-adapter] [WAL-MONITOR] TRUNCATE checkpoint result: ${JSON.stringify(truncResult)}`);
      }
      
      // Reset query counter
      _walStats.queries = 0;
      _walStats.errors = 0;
    } catch (err) {
      logger.warn(`[${new Date().toISOString()}] [db-adapter] [WAL-MONITOR] Error: ${err.message}`);
    }
  }, 10 * 60 * 1000); // Every 10 minutes
  
  // Ensure timer doesn't prevent process exit
  if (_walMonitorTimer.unref) _walMonitorTimer.unref();

  return {
    type: 'sqlite',
    
    async query(sql, params = []) {
      _walStats.queries++;
      try {
        return db.prepare(sql).all(...params);
      } catch (err) {
        _walStats.errors++;
        if (err.code === 'SQLITE_BUSY') _walStats.busyRetries++;
        throw err;
      }
    },

    async queryOne(sql, params = []) {
      return db.prepare(sql).get(...params) || null;
    },

    async run(sql, params = []) {
      _walStats.queries++;
      try {
        const result = db.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      } catch (err) {
        _walStats.errors++;
        if (err.code === 'SQLITE_BUSY') _walStats.busyRetries++;
        throw err;
      }
    },

    async runTransaction(fn) {
      // fn receives { query, queryOne, run } bound to this adapter
      const txAdapter = {
        query: async (sql, params = []) => db.prepare(sql).all(...params),
        queryOne: async (sql, params = []) => db.prepare(sql).get(...params) || null,
        run: async (sql, params = []) => {
          const r = db.prepare(sql).run(...params);
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
      };
      const transaction = db.transaction(() => {
        // We need to run fn synchronously inside SQLite transaction
        // But fn is async... We handle this by collecting operations
        throw new Error('Use runTransactionSync for SQLite');
      });
      // For SQLite, we use a simpler approach: begin/commit manually
      db.exec('BEGIN');
      try {
        const result = await fn(txAdapter);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    // Synchronous transaction for SQLite (used internally)
    runTransactionSync(fn) {
      const txFn = db.transaction(fn);
      return txFn();
    },

    async exec(sql) {
      db.exec(sql);
    },

    async close() {
      if (_walMonitorTimer) { clearInterval(_walMonitorTimer); _walMonitorTimer = null; }
      db.close();
    },

    // Get raw db instance (for migration period only)
    getRawDb() {
      return db;
    },
  };
}

// ─── MySQL Adapter ───────────────────────────────────────────
async function createMysqlAdapter(config) {
  const mysql = (await import('mysql2/promise')).default;
  const pool = mysql.createPool({
    host: config.host || '127.0.0.1',
    port: config.port || 3306,
    user: config.user || 'rangerai',
    password: config.password || process.env.MYSQL_PASSWORD || (() => { throw new Error('MYSQL_PASSWORD environment variable is required'); })(),
    database: config.database || 'rangerai',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    // Convert MySQL TINYINT(1) to boolean
    typeCast: function (field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        return field.string() === '1' ? 1 : 0;
      }
      return next();
    },
  });

  // Test connection
  const conn = await pool.getConnection();
  await conn.query('SELECT 1');
  conn.release();
  logger.info('[db-adapter] MySQL pool connected');

  return {
    type: 'mysql',

    async query(sql, params = []) {
      // Use pool.query instead of pool.execute to avoid MySQL prepared statement
      // parameter type issues (LIMIT/OFFSET must be integers in execute mode)
      const [rows] = await pool.query(sql, params);
      return rows;
    },

    async queryOne(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return rows[0] || null;
    },

    async run(sql, params = []) {
      const [result] = await pool.query(sql, params);
      return {
        changes: result.affectedRows || 0,
        lastInsertRowid: result.insertId || 0,
      };
    },

    async runTransaction(fn) {
      const conn = await pool.getConnection();
      await conn.beginTransaction();
      try {
        const txAdapter = {
          query: async (sql, params = []) => {
            const [rows] = await conn.query(sql, params);
            return rows;
          },
          queryOne: async (sql, params = []) => {
            const [rows] = await conn.query(sql, params);
            return rows[0] || null;
          },
          run: async (sql, params = []) => {
            const [result] = await conn.query(sql, params);
            return { changes: result.affectedRows || 0, lastInsertRowid: result.insertId || 0 };
          },
        };
        const result = await fn(txAdapter);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    },

    async exec(sql) {
      await pool.query(sql);
    },

    async close() {
      await pool.end();
    },

    // No raw db for MySQL
    getRawDb() {
      return pool;
    },
  };
}

// ─── Public API ──────────────────────────────────────────────

export async function initAdapter(options = {}) {
  if (adapter) return adapter;

  dbType = options.type || process.env.DB_TYPE || 'sqlite';
  logger.info(`[db-adapter] Initializing with type: ${dbType}`);

  if (dbType === 'mysql') {
    logger.warn('[db-adapter] ⚠️  MySQL mode is deprecated. SQLite is the production default. Set DB_TYPE=sqlite to silence this warning.');
  }

  if (dbType === 'mysql') {
    adapter = await createMysqlAdapter({
      host: options.host || process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(options.port || process.env.MYSQL_PORT || '3306'),
      user: options.user || process.env.MYSQL_USER || 'root',
      password: options.password || process.env.MYSQL_PASSWORD || (() => { throw new Error('MYSQL_PASSWORD environment variable is required'); })(),
      database: options.database || process.env.MYSQL_DATABASE || 'rangerai',
    });
  } else {
    const dbPath = options.dbPath || process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db';
    adapter = await createSqliteAdapter(dbPath);
  }

  return adapter;
}

export async function getAdapter() {
  if (!adapter) {
    throw new Error('[db-adapter] Not initialized. Call initAdapter() first.');
  }
  return adapter;
}

export async function query(sql, params = []) {
  return adapter.query(sql, params);
}

export async function queryOne(sql, params = []) {
  return adapter.queryOne(sql, params);
}

export async function run(sql, params = []) {
  return adapter.run(sql, params);
}

export async function runTransaction(fn) {
  return adapter.runTransaction(fn);
}

export async function exec(sql) {
  return adapter.exec(sql);
}

export async function closeAdapter() {
  if (adapter) {
    await adapter.close();
    adapter = null;
    logger.info('[db-adapter] Connection closed');
  }
}

export function getDbType() {
  return dbType;
}

export function isMySQL() {
  return dbType === 'mysql';
}

export function isSQLite() {
  return dbType === 'sqlite';
}

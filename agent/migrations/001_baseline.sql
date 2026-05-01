CREATE TABLE request_traces (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id   TEXT NOT NULL,
        session_key TEXT,
        user_id    TEXT,
        model      TEXT,
        message_len INTEGER DEFAULT 0,
        total_ms   INTEGER DEFAULT 0,
        status     TEXT DEFAULT 'pending',  -- pending | success | error | timeout
        error_msg  TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        finished_at TEXT
      , gateway_cost TEXT, token_source TEXT DEFAULT 'estimate', prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0);
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE trace_spans (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id   TEXT NOT NULL,
        span_name  TEXT NOT NULL,   -- 阶段名：knowledge_inject / recall / gateway_send / stream 等
        started_at INTEGER NOT NULL,  -- epoch ms
        ended_at   INTEGER,
        duration_ms INTEGER,
        status     TEXT DEFAULT 'ok',  -- ok | error | skip
        meta       TEXT               -- JSON 附加信息
      );
CREATE INDEX idx_traces_created ON request_traces(created_at);
CREATE INDEX idx_traces_model ON request_traces(model);
CREATE INDEX idx_spans_trace ON trace_spans(trace_id);
CREATE TABLE chats (
        id          TEXT PRIMARY KEY,
        sessionKey  TEXT NOT NULL UNIQUE,
        title       TEXT NOT NULL DEFAULT '新对话',
        model       TEXT,
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt   TEXT NOT NULL DEFAULT (datetime('now')),
        userId      TEXT,
        tags        TEXT,
        metadata    TEXT
      );
CREATE TABLE messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role      TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content   TEXT NOT NULL,
        model     TEXT,
        tokens    INTEGER,
        msgId     TEXT,
        metadata  TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE INDEX idx_messages_chatId ON messages(chatId);
CREATE INDEX idx_chats_updatedAt ON chats(updatedAt);
CREATE INDEX idx_chats_userId ON chats(userId);
CREATE TABLE shared_chats (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sharedWithUserId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sharedByUserId   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission  TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write')),
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(chatId, sharedWithUserId)
      );
CREATE INDEX idx_shared_chats_chatId ON shared_chats(chatId);
CREATE INDEX idx_shared_chats_sharedWith ON shared_chats(sharedWithUserId);
CREATE TABLE users (
        id          TEXT PRIMARY KEY,
        username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
        passwordHash TEXT NOT NULL,
        salt        TEXT NOT NULL,
        displayName TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
        team        TEXT,
        isActive    INTEGER NOT NULL DEFAULT 1,
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        lastLoginAt TEXT
      , department_id TEXT, manager_id TEXT, org_level INTEGER DEFAULT 4, tree_path TEXT DEFAULT '/', email TEXT, phone TEXT, avatar TEXT, password_reset_token TEXT, password_reset_expires TEXT);
CREATE TABLE knowledge_docs (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT DEFAULT '',
        category    TEXT DEFAULT '未分类',
        tags        TEXT DEFAULT '',
        fileName    TEXT,
        filePath    TEXT,
        fileSize    INTEGER DEFAULT 0,
        mimeType    TEXT DEFAULT 'text/plain',
        content     TEXT DEFAULT '',
        uploadedBy  TEXT,
        isActive    INTEGER DEFAULT 1,
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt   TEXT NOT NULL DEFAULT (datetime('now'))
      , scope TEXT DEFAULT 'general', priority INTEGER DEFAULT 50, enabled INTEGER DEFAULT 1);
CREATE INDEX idx_knowledge_category ON knowledge_docs(category);
CREATE INDEX idx_knowledge_uploadedBy ON knowledge_docs(uploadedBy);
CREATE INDEX idx_knowledge_createdAt ON knowledge_docs(createdAt);
CREATE VIRTUAL TABLE knowledge_docs_fts USING fts5(
        title, description, content, tags,
        content='knowledge_docs',
        content_rowid='rowid'
      )
/* knowledge_docs_fts(title,description,content,tags) */;
CREATE TABLE IF NOT EXISTS 'knowledge_docs_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE IF NOT EXISTS 'knowledge_docs_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'knowledge_docs_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'knowledge_docs_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts(rowid, title, description, content, tags)
        VALUES (new.rowid, new.title, new.description, new.content, new.tags);
      END;
CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts(knowledge_docs_fts, rowid, title, description, content, tags)
        VALUES ('delete', old.rowid, old.title, old.description, old.content, old.tags);
      END;
CREATE TRIGGER knowledge_fts_update AFTER UPDATE ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts(knowledge_docs_fts, rowid, title, description, content, tags)
        VALUES ('delete', old.rowid, old.title, old.description, old.content, old.tags);
        INSERT INTO knowledge_docs_fts(rowid, title, description, content, tags)
        VALUES (new.rowid, new.title, new.description, new.content, new.tags);
      END;
CREATE TABLE knowledge_references (
        id TEXT PRIMARY KEY,
        messageId TEXT NOT NULL,
        knowledgeDocId TEXT NOT NULL,
        snippet TEXT DEFAULT '',
        createdAt INTEGER DEFAULT (strftime('%s','now') * 1000)
      );
CREATE INDEX idx_kref_messageId ON knowledge_references(messageId);
CREATE INDEX idx_kref_docId ON knowledge_references(knowledgeDocId);
CREATE TABLE workflows (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT DEFAULT '',
        steps       TEXT NOT NULL DEFAULT '[]',
        category    TEXT DEFAULT '未分类',
        createdBy   TEXT,
        isActive    INTEGER DEFAULT 1,
        runCount    INTEGER DEFAULT 0,
        lastRunAt   TEXT,
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        cronExpression TEXT DEFAULT NULL,
        cronEnabled INTEGER DEFAULT 0,
        nextRunAt   TEXT DEFAULT NULL,
        updatedAt   TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE INDEX idx_workflows_createdBy ON workflows(createdBy);
CREATE INDEX idx_workflows_category ON workflows(category);
CREATE INDEX idx_workflows_cronEnabled ON workflows(cronEnabled);
CREATE TABLE workflow_runs (
        id          TEXT PRIMARY KEY,
        workflowId  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        startedAt   TEXT,
        completedAt TEXT,
        result      TEXT DEFAULT '',
        error       TEXT DEFAULT '',
        triggeredBy TEXT DEFAULT 'manual',
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (workflowId) REFERENCES workflows(id)
      );
CREATE INDEX idx_workflow_runs_wfId ON workflow_runs(workflowId);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
CREATE TABLE audit_logs (
        id        TEXT PRIMARY KEY,
        userId    TEXT NOT NULL,
        username  TEXT DEFAULT '',
        action    TEXT NOT NULL,
        targetType TEXT DEFAULT '',
        targetId  TEXT DEFAULT '',
        details   TEXT DEFAULT '',
        ip        TEXT DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE INDEX idx_audit_logs_userId ON audit_logs(userId);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_createdAt ON audit_logs(createdAt);
CREATE TABLE knowledge_embeddings (
        id         TEXT PRIMARY KEY,
        docId      TEXT NOT NULL,
        chunkIndex INTEGER NOT NULL DEFAULT 0,
        chunkText  TEXT DEFAULT '',
        embedding  BLOB,
        createdAt  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (docId) REFERENCES knowledge_docs(id)
      );
CREATE INDEX idx_ke_docId ON knowledge_embeddings(docId);
CREATE INDEX idx_knowledge_scope ON knowledge_docs(scope);
CREATE INDEX idx_knowledge_enabled ON knowledge_docs(enabled);
CREATE TABLE task_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        chat_id TEXT,
        msg_id TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        step_count INTEGER NOT NULL DEFAULT 0,
        steps_completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      , plan_version INTEGER DEFAULT 1, goal TEXT);
CREATE INDEX idx_tp_session ON task_plans(session_key);
CREATE INDEX idx_tp_status ON task_plans(status);
CREATE INDEX idx_tp_msg ON task_plans(msg_id);
CREATE TABLE token_cost_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT,
      chat_id      TEXT,
      session_key  TEXT,
      model        TEXT,
      task_family  TEXT,
      turn_index   INTEGER DEFAULT 0,
      prompt_tokens      INTEGER DEFAULT 0,
      completion_tokens  INTEGER DEFAULT 0,
      cache_read_tokens  INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens       INTEGER DEFAULT 0,
      est_cost_usd       REAL DEFAULT 0,
      tool_count         INTEGER DEFAULT 0,
      is_retry           INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now'))
    );
CREATE INDEX idx_tcl_created ON token_cost_log(created_at);
CREATE INDEX idx_tcl_model   ON token_cost_log(model);
CREATE INDEX idx_tcl_family  ON token_cost_log(task_family);
CREATE INDEX idx_tcl_chat    ON token_cost_log(chat_id);
CREATE TABLE system_config (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT DEFAULT (datetime('now')),
        updated_by  TEXT
      );
CREATE TABLE schema_versions (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
      checksum    TEXT,
      duration_ms INTEGER
    );

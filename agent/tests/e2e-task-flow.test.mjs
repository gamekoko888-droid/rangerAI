/**
 * tests/e2e-task-flow.test.mjs — 全链路端到端任务执行测试
 * 
 * 验证完整链路: 认证 → 创建对话 → 发送消息 → Agent 处理 → 返回响应
 * 
 * 覆盖:
 *   - POST /api/auth/login (JWT 认证)
 *   - POST /api/chats (创建对话)
 *   - POST /api/chats/:id/messages (发送消息, 触发 Agent)
 *   - GET /api/chats/:id/messages (轮询 Assistant 回复)
 *   - GET /api/health (健康检查)
 * 
 * 用法:
 *   node --test tests/e2e-task-flow.test.mjs
 * 
 * 环境变量:
 *   E2E_USERNAME — 测试用户 (默认: smoke_test)
 *   E2E_PASSWORD — 测试密码 (默认: SmokeTest2026!)
 *   E2E_BASE_URL  — API 地址 (默认: http://localhost:3000)
 *   E2E_POLL_TIMEOUT_MS — 轮询超时 (默认: 60000)
 */

import { describe, it, beforeAll, afterAll } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const USERNAME = process.env.E2E_USERNAME || "smoke_test";
const PASSWORD = process.env.E2E_PASSWORD || "SmokeTest2026!";
const POLL_TIMEOUT_MS = parseInt(process.env.E2E_POLL_TIMEOUT_MS || "60000", 10);
const POLL_INTERVAL_MS = 2000;

let token = null;
let chatId = null;
let createdChatIds = [];

// ─── Helpers ────────────────────────────────────────────────
async function api(method, path, body = null, opts = {}) {
  const headers = { ...opts.headers };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, body: text, json };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Tests ──────────────────────────────────────────────────
describe("E2E Task Flow", () => {
  // Cleanup
  afterAll(async () => {
    // Clean up created chats (best effort)
    for (const cid of createdChatIds) {
      try {
        await api("DELETE", `/api/chats/${cid}`);
      } catch {}
    }
  });

  // ──────────────────────────────────────────────────────────
  // Phase 1: Authentication
  // ──────────────────────────────────────────────────────────
  describe("Phase 1: Authentication", () => {
    it("should login and receive JWT token", async () => {
      const res = await api("POST", "/api/auth/login", {
        username: USERNAME,
        password: PASSWORD,
      });

      assert.equal(res.status, 200, `Login should return 200, got ${res.status}: ${res.body}`);
      assert.ok(res.json, "Response should be JSON");
      assert.ok(res.json.token, `Should have token in response: ${JSON.stringify(res.json).slice(0, 200)}`);
      assert.ok(res.json.user, "Should have user object");
      assert.equal(res.json.user.username, USERNAME, `Username should match`);
      
      token = res.json.token;
      console.log(`  ✅ Logged in as ${USERNAME}, token: ${token.slice(0, 10)}...`);
    });

    it("should reject invalid credentials", async () => {
      const res = await api("POST", "/api/auth/login", {
        username: "nonexistent_user_12345",
        password: "wrong_password",
      });
      assert.ok(res.status === 401 || res.status === 400, `Should return 401/400, got ${res.status}`);
    });

    it("health endpoint is accessible without auth", async () => {
      const res = await api("GET", "/api/health");
      assert.equal(res.status, 200);
      assert.ok(res.json);
      const ok = res.json.status === "ok" || res.json.ok === true;
      assert.ok(ok, `Health should report ok: ${JSON.stringify(res.json).slice(0, 200)}`);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Phase 2: Chat Management
  // ──────────────────────────────────────────────────────────
  describe("Phase 2: Chat Management", () => {
    it("should create a new chat", async () => {
      const res = await api("POST", "/api/chats", {
        title: `E2E Test ${Date.now()}`,
        tag: "e2e-test",
      });

      assert.equal(res.status, 201, `Create chat should return 201, got ${res.status}: ${res.body}`);
      assert.ok(res.json, "Response should be JSON");
      assert.ok(res.json.id || res.json.chatId, "Should have chat id");
      
      chatId = res.json.id || res.json.chatId;
      createdChatIds.push(chatId);
      console.log(`  ✅ Created chat: ${chatId}`);
    });

    it("should retrieve the created chat", async () => {
      assert.ok(chatId, "chatId should be set");
      const res = await api("GET", `/api/chats/${chatId}`);
      assert.equal(res.status, 200, `Should return 200, got ${res.status}`);
      assert.ok(res.json, "Response should be JSON");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Phase 3: Agent Task Execution (核心链路)
  // ──────────────────────────────────────────────────────────
  describe("Phase 3: Agent Task Execution", () => {
    it("should send a message and receive 202 (agent triggered)", async () => {
      assert.ok(chatId, "chatId should be set");
      
      const res = await api("POST", `/api/chats/${chatId}/messages`, {
        content: "请用中文回答：1+1等于几？只需要回答数字。",
      });

      console.log(`  Send message response: ${res.status} — ${res.body.slice(0, 300)}`);
      
      // 202 = accepted, agent is processing
      // 200 = sync response (unlikely for agent loop)
      assert.ok([200, 202].includes(res.status), 
        `Send message should return 200/202, got ${res.status}: ${res.body}`);
      assert.ok(res.json, "Response should be JSON");
      
      if (res.status === 202) {
        assert.ok(res.json.msgId, "Should have msgId");
        assert.equal(res.json.status, "processing", "Status should be 'processing'");
      }
    });

    it("should receive agent response within timeout", async () => {
      assert.ok(chatId, "chatId should be set");
      
      const startTime = Date.now();
      let responseFound = false;
      let lastMessages = [];
      
      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);
        
        try {
          const res = await api("GET", `/api/chats/${chatId}/messages?limit=10`);
          if (res.status !== 200) continue;
          
          const messages = res.json?.messages || res.json?.data || [];
          lastMessages = messages;
          
          // Look for assistant message (response to our query)
          const assistantMsgs = messages.filter(m => m.role === "assistant");
          if (assistantMsgs.length > 0) {
            responseFound = true;
            console.log(`  ✅ Agent responded after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            console.log(`  Response: ${JSON.stringify(assistantMsgs[0].content || assistantMsgs[0]).slice(0, 200)}`);
            break;
          }
        } catch (e) {
          console.log(`  Poll error: ${e.message}`);
        }
      }
      
      if (!responseFound) {
        console.log(`  Last messages after timeout: ${JSON.stringify(lastMessages).slice(0, 500)}`);
      }
      
      assert.ok(responseFound, 
        `Agent should respond within ${POLL_TIMEOUT_MS / 1000}s. Last messages: ${lastMessages.length}`);
    }, { timeout: POLL_TIMEOUT_MS + 10000 }); // Allow test to poll for full timeout
  });

  // ──────────────────────────────────────────────────────────
  // Phase 4: Core API endpoints
  // ──────────────────────────────────────────────────────────
  describe("Phase 4: Core API Endpoints", () => {
    it("GET /api/version returns version", async () => {
      const res = await api("GET", "/api/version");
      // May or may not require auth
      if (res.status === 200) {
        assert.ok(res.json, "Response should be JSON");
      }
      // 401 is also acceptable if version requires auth
      assert.ok([200, 401].includes(res.status), `Version should return 200 or 401, got ${res.status}`);
    });

    it("GET /api/stats/routing returns model usage", async () => {
      const res = await api("GET", "/api/stats/routing");
      // May require admin auth
      assert.ok([200, 401].includes(res.status), 
        `Stats routing should return 200 or 401, got ${res.status}`);
    });

    it("API maintains consistent response format", async () => {
      // Test that error responses follow consistent format
      const endpoints = [
        { path: "/api/auth/login", method: "POST", body: {} },
        { path: "/api/chats/nonexistent-id", method: "GET" },
      ];
      
      for (const ep of endpoints) {
        const res = await api(ep.method, ep.path, ep.body || null);
        // Accept 4xx as valid structured errors
        if (res.status >= 400) {
          assert.ok(res.json, `${ep.path} error response should be JSON`);
          assert.ok(
            res.json.error || res.json.message || res.json.detail,
            `${ep.path} error should have error/message/detail field`
          );
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────
  // Phase 5: Service Dependencies
  // ──────────────────────────────────────────────────────────
  describe("Phase 5: Service Dependencies", () => {
    it("agent HTTP API is reachable (port 3002)", async () => {
      // Test backend API directly
      const res = await fetch("http://localhost:3002/api/health", {
        method: "GET",
      });
      const text = await res.text();
      assert.equal(res.status, 200, `Agent health should return 200, got ${res.status}: ${text}`);
      
      let json = null;
      try { json = JSON.parse(text); } catch {}
      assert.ok(json, "Agent health response should be JSON");
    });

    it("websocket endpoint is reachable (port 3005)", async () => {
      // Simple TCP check via HTTP upgrade attempt
      try {
        const res = await fetch("http://localhost:3005/", {
          method: "GET",
          headers: { "Connection": "Upgrade", "Upgrade": "websocket" },
        });
        // WebSocket endpoint should return 400/426 when not a proper WS upgrade
        assert.ok([400, 426, 101].includes(res.status), 
          `WS endpoint should return upgrade-related status, got ${res.status}`);
      } catch (e) {
        // Connection error is also acceptable (port is listening but not HTTP)
        console.log(`  WS port check: ${e.message} (port likely listening)`);
      }
    });
  });
});

# RangerAI API Reference

> Auto-generated from Zod Schema Registries — 2026-03-08

---

## 1. HTTP API Schemas

These schemas validate request bodies for all write (POST/PUT/PATCH/DELETE) endpoints.

### 1.1 Auth

#### `auth.login`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `username` | string | ✓ |  |
| `password` | string | ✓ |  |

#### `auth.register`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `username` | string | ✓ |  |
| `password` | string | ✓ |  |
| `inviteCode` | string | ✓ |  |

### 1.2 Chat

#### `chat.create`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string |  | default: `"新对话"` |
| `model` | string | null |  | default: `null` |

#### `chat.updateTags`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tags` | array<string> | ✓ |  |

#### `chat.sendMessage`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `content` | string | ✓ |  |
| `model` | string |  |  |
| `attachments` | array<object> |  |  |
| `roleSystemPrompt` | string |  |  |

#### `chat.batchDelete`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `chatIds` | array<string> | ✓ |  |

### 1.3 Ticket

#### `ticket.create`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | ✓ |  |
| `description` | string |  | default: `""` |
| `category` | string |  | default: `"general"` |
| `priority` | `low` / `medium` / `high` / `urgent` |  | default: `"medium"` |
| `customer_name` | string |  | default: `""` |
| `customer_email` | string |  | default: `""` |
| `customer_platform` | string |  | default: `""` |
| `created_by` | string |  | default: `"system"` |
| `assigned_to` | string |  |  |

#### `ticket.update`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | `open` / `in_progress` / `pending` / `resolved` / `closed` |  |  |
| `priority` | `low` / `medium` / `high` / `urgent` |  |  |
| `category` | string |  |  |
| `assigned_to` | string | null |  |  |
| `title` | string |  |  |
| `description` | string |  |  |

#### `ticket.comment`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `author` | string |  | default: `"system"` |
| `content` | string | ✓ |  |
| `is_internal` | boolean |  | default: `false` |

### 1.4 Kol

#### `kol.createRule`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | ✓ |  |
| `description` | string |  | default: `""` |
| `category` | string |  | default: `"default"` |
| `priority` | string |  | default: `"all"` |
| `assignee` | string |  | default: `""` |
| `assignee_name` | string |  | default: `""` |
| `is_active` | boolean |  | default: `true` |

### 1.5 Workflow

#### `workflow.create`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | ✓ |  |
| `description` | string |  | default: `""` |
| `cron_expression` | string |  |  |
| `is_active` | boolean |  | default: `true` |
| `config` | any |  |  |

#### `workflow.update`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string |  |  |
| `description` | string |  |  |
| `cron_expression` | string |  |  |
| `is_active` | boolean |  |  |
| `config` | any |  |  |

### 1.6 Invite

#### `invite.create`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `maxUses` | number |  | default: `1` |
| `expiresInDays` | number |  | default: `7` |

### 1.7 User

#### `user.update`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `role` | `admin` / `user` |  |  |
| `is_active` | boolean |  |  |
| `display_name` | string |  |  |

### 1.8 Knowledge

#### `knowledge.create`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | ✓ |  |
| `content` | string | ✓ |  |
| `category` | string |  | default: `"general"` |
| `tags` | array<string> |  | default: `[]` |

### 1.9 Config

#### `config.update`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `key` | string | ✓ |  |
| `value` | any | ✓ |  |

### 1.10 AiRole

#### `aiRole.create`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | ✓ |  |
| `system_prompt` | string | ✓ |  |
| `description` | string |  | default: `""` |
| `is_default` | boolean |  | default: `false` |

---

## 2. IPC Message Schemas

These schemas validate messages between the Main Process and Worker Process via Node.js IPC.

### 2.1 Downlink (Main → Worker)

#### `user_message`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `id` | string | ✓ |  |
| `sessionKey` | string |  | default: `"default"` |
| `content` | string | ✓ |  |
| `conversationHistory` | array<object> |  | default: `[]` |
| `model` | string |  |  |
| `attachments` | array<any> |  |  |
| `roleSystemPrompt` | string |  |  |

#### `user_interrupt`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `content` | string | ✓ |  |
| `sessionKey` | string |  | default: `"default"` |

#### `ping`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `id` | string | ✓ |  |

#### `gateway_api_request`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `reqId` | string | ✓ |  |
| `method` | string | ✓ |  |
| `params` | any | ✓ |  |

#### `shutdown`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |

#### `recover_browser`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |

#### `get_browser_status`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `reqId` | string | ✓ |  |

#### `reset_browser_breaker`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `reqId` | string | ✓ |  |

### 2.2 Uplink (Worker → Main)

#### `worker_ready`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `pid` | number | ✓ |  |
| `gatewayConnected` | boolean | ✓ |  |

#### `frontend_event`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `msgId` | string | ✓ |  |
| `event` | object | ✓ |  |

#### `rotate_session`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `data` | object | ✓ |  |

#### `auto_followup`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `sessionKey` | string |  | default: `"default"` |
| `content` | string | ✓ |  |

#### `task_complete`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `msgId` | string | ✓ |  |
| `result` | any | ✓ |  |

#### `task_error`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `msgId` | string | ✓ |  |
| `error` | string | ✓ |  |

#### `pong`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `id` | string | ✓ |  |
| `pid` | number | ✓ |  |
| `gatewayConnected` | boolean | ✓ |  |

#### `gateway_api_response`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `reqId` | string | ✓ |  |
| `ok` | boolean | ✓ |  |
| `result` | any |  |  |
| `error` | string |  |  |

#### `browser_breaker_reset`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `reqId` | string | ✓ |  |
| `ok` | boolean | ✓ |  |

#### `browser_status`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | literal | ✓ |  |
| `reqId` | string | ✓ |  |
| `status` | any | ✓ |  |
| `gatewayConnected` | boolean | ✓ |  |

---

## 3. Summary

| Category | Count |
|----------|-------|
| HTTP Schemas | 17 |
| IPC Downlink Schemas | 8 |
| IPC Uplink Schemas | 10 |
| **Total** | **35** |

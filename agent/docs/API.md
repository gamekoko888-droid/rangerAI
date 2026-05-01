# RangerAI API Documentation v3.1.0

> Auto-generated from source code analysis. Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Base URL
- Production: `https://ranger.voyage`
- Local: `http://127.0.0.1:3002`

## Authentication
All protected endpoints require a JWT token in the `Authorization` header:
```
Authorization: Bearer <jwt_token>
```

Public endpoints (no auth required): `/api/auth/login`, `/api/auth/register`, `/api/health`, `/api/version`

---

## Auth API (`/api/auth/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | No | Login with username/password |
| POST | `/api/auth/register` | No | Register with invite code |
| GET | `/api/auth/me` | Yes | Get current user profile |
| POST | `/api/auth/logout` | Yes | Logout (invalidate token) |
| POST | `/api/auth/invite-codes` | Admin | Create invite code |
| GET | `/api/auth/invite-codes` | Admin | List invite codes |
| DELETE | `/api/auth/invite-codes/:id` | Admin | Deactivate invite code |
| POST | `/api/auth/change-password` | Yes | Change user password |

## Chat API (`/api/chats/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/chats` | Yes | List all chats (filtered by user) |
| POST | `/api/chats` | Yes | Create a new chat |
| GET | `/api/chats/:id` | Yes | Get chat details + messages |
| PATCH | `/api/chats/:id` | Yes | Update chat title |
| DELETE | `/api/chats/:id` | Yes | Delete a chat |
| POST | `/api/chats/:id/messages` | Yes | Send a message (triggers AI) |

## User Management API (`/api/users/*`, `/api/admin/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/users` | Yes | List users |
| GET | `/api/users/:id` | Yes | Get user details |
| PUT | `/api/admin/users/:id/role` | Admin | Update user role |
| DELETE | `/api/admin/users/:id` | Admin | Delete user |

## Ticket API (`/api/tickets/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/tickets` | Yes | List tickets |
| POST | `/api/tickets` | Yes | Create ticket |
| GET | `/api/tickets/:id` | Yes | Get ticket details |
| PATCH | `/api/tickets/:id` | Yes | Update ticket |
| DELETE | `/api/tickets/:id` | Yes | Delete ticket |

## KOL API (`/api/kols/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/kols` | Yes | List KOL partners |
| POST | `/api/kols` | Yes | Add KOL partner |
| GET | `/api/kols/:id` | Yes | Get KOL details |
| PUT | `/api/kols/:id` | Yes | Update KOL |
| DELETE | `/api/kols/:id` | Yes | Delete KOL |

## TikTok API (`/api/tiktok/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/tiktok/partners` | Yes | List TikTok partners |
| GET | `/api/tiktok/partners/:id` | Yes | Get partner details |
| POST | `/api/tiktok/partners` | Yes | Add TikTok partner |
| PUT | `/api/tiktok/partners/:id` | Yes | Update partner |
| DELETE | `/api/tiktok/partners/:id` | Yes | Delete partner |

## Knowledge Base API (`/api/knowledge/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/knowledge` | Yes | List knowledge documents |
| POST | `/api/knowledge` | Yes | Upload document |
| GET | `/api/knowledge/:id` | Yes | Get document details |
| DELETE | `/api/knowledge/:id` | Yes | Delete document |
| PATCH | `/api/knowledge/:id` | Yes | Update document metadata |
| GET | `/api/knowledge/categories` | Yes | List categories |
| POST | `/api/knowledge/search` | Yes | Search documents |

## Notification API (`/api/notifications/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/notifications` | Yes | List notifications |
| PATCH | `/api/notifications/:id/read` | Yes | Mark as read |
| POST | `/api/notifications/read-all` | Yes | Mark all as read |

## Workflow API (`/api/workflows/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/workflows` | Yes | List workflows |
| POST | `/api/workflows` | Yes | Create workflow |
| GET | `/api/workflows/:id` | Yes | Get workflow details |
| PUT | `/api/workflows/:id` | Yes | Update workflow |
| DELETE | `/api/workflows/:id` | Yes | Delete workflow |

## System API

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | No | Health check |
| GET | `/api/version` | No | API version info |
| GET | `/api/stats` | No | Database statistics |
| GET | `/api/prompts` | Yes | List prompt templates |
| GET | `/api/system` | Yes | System information |
| GET | `/api/audit-logs` | Yes | Audit log entries |
| GET | `/api/roles` | Yes | List roles |

## WebSocket

| Endpoint | Auth | Description |
|----------|------|-------------|
| `wss://ranger.voyage/ws` | Token | Real-time chat & notifications |

### WebSocket Message Types
- `bind_chat` — Bind to a chat session
- `user_message` — Send user message
- `ai_response` — Receive AI response (streaming)
- `heartbeat` / `pong` — Keep-alive (30s interval)

## Rate Limiting
- Auth endpoints: 10 req/min per IP
- Write operations (POST/PUT/DELETE): 30 req/min per IP
- Read operations (GET): 60 req/min per IP

## Error Responses
```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

| Status | Description |
|--------|-------------|
| 400 | Bad Request (invalid input) |
| 401 | Unauthorized (missing/invalid token) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not Found |
| 429 | Too Many Requests (rate limited) |
| 500 | Internal Server Error |

## ACP API (`/acp/v1/*`) — Admin Control Panel

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/acp/v1/health` | No | ACP health check |
| GET | `/acp/v1/status` | No | ACP status |
| GET | `/acp/v1/admin/keys` | Admin JWT | List API keys |
| POST | `/acp/v1/admin/keys` | Admin JWT | Create API key |
| DELETE | `/acp/v1/admin/keys/:id` | Admin JWT | Revoke API key |

## OpenClaw Gateway (`/v1/*`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/v1/chat/completions` | API Key | OpenAI-compatible chat completions |

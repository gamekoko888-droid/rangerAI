# RangerAI Agent Backend

AI-powered autonomous agent system with multi-model routing, knowledge management, and workflow automation.

## Quick Start

```bash
# Start the server
sudo systemctl start rangerai-agent

# Check status
sudo systemctl status rangerai-agent

# View logs
journalctl -u rangerai-agent -f
```

## Architecture

- **server.mjs** — HTTP server orchestration (v69)
- **modules/** — Core modules (WebSocket, HTTP routing, AI services, etc.)
- **api/** — REST API handlers (auth, chat, system, knowledge, workflow)
- **lib/** — Bootstrap, context, signals, logging
- **worker/** — Agent worker for async task processing
- **scripts/** — Deployment and maintenance scripts

## Key Services

| Service | Port | Description |
|---------|------|-------------|
| rangerai-agent | 3001 | Main backend API + WebSocket |
| MySQL | 3306 | Primary database |
| Redis | 6380 | Rate limiting + caching |
| SearXNG | 8888 | Search engine |
| OpenClaw Gateway | 18789 | AI agent orchestration |

## Development

```bash
# Edit code
vim /opt/rangerai-agent/server.mjs

# Restart after changes
sudo systemctl restart rangerai-agent

# Run regression tests
bash /opt/rangerai-agent/scripts/regression-test.sh
```

## Deployment

```bash
# Frontend deployment
bash /opt/rangerai-agent/deploy-frontend.sh

# Full deployment (via skill)
# Managed by OpenClaw deploy skill
```

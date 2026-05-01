# Recovery Policy — Gateway & Agent Services

> Last updated: Iter-8 (2026-03-08)

## Design Decision

Gateway and Agent services use an **"alert + manual intervention"** recovery strategy,
NOT automatic restart. This is an intentional design choice, not a missing feature.

### Rationale

1. **Data Integrity**: Auto-restarting gateway/agent during active tasks risks:
   - Interrupting in-progress conversations
   - Losing unsaved task state
   - Corrupting event buffers

2. **Blast Radius Control**: Automated restart can cascade failures:
   - Port conflicts with the dying process
   - Race conditions during reconnection
   - Double-processing of queued messages

3. **Observability First**: Alerts give operators time to:
   - Diagnose root cause before recovery
   - Decide between restart vs. graceful drain
   - Verify dependent services are healthy

## What Happens on Failure

| Component | Detection | Action | Human SOP |
|-----------|-----------|--------|-----------|
| Gateway WS | Heartbeat timeout | Log alert, mark DISCONNECTED | Check gateway logs, restart if needed |
| Agent Worker | Process exit / unresponsive | Log alert, mark UNHEALTHY | Use /admin/restart-worker endpoint |
| Redis | Connection lost | Auto-reconnect (built-in) | N/A (self-healing) |
| Database | Query timeout | Log error, degrade gracefully | Check DB health, restart server if needed |

## Manual Recovery Commands

```bash
# Restart agent worker (safe, no data loss)
curl -X POST http://localhost:3002/admin/restart-worker -H "Authorization: Bearer <ADMIN_TOKEN>"

# Full server restart (use with caution)
sudo systemctl restart rangerai-agent

# Check health
curl http://localhost:3002/health
curl http://localhost:3002/api/metrics/health
```

## Future Considerations

If auto-recovery is desired in the future, implement with:
- Graceful drain period before restart
- Task state checkpoint before kill
- Exponential backoff on repeated failures
- Circuit breaker on restart attempts

#!/bin/bash
# RangerAI Safe Restart Script
# Usage: sudo bash /opt/rangerai-agent/restart.sh

echo "[$(date)] Starting RangerAI restart..."

# Check if systemd service exists
if systemctl is-active --quiet rangerai-agent 2>/dev/null; then
    echo "Restarting via systemd..."
    systemctl restart rangerai-agent
    sleep 3
    systemctl status rangerai-agent --no-pager
else
    echo "Restarting via process kill..."
    # Find the server.mjs process
    PID=$(pgrep -f "node.*server.mjs" | head -1)
    if [ -n "$PID" ]; then
        echo "Killing PID $PID..."
        kill -SIGTERM $PID
        sleep 2
        # Force kill if still running
        if kill -0 $PID 2>/dev/null; then
            kill -9 $PID
            sleep 1
        fi
    fi
    
    # Start fresh
    cd /opt/rangerai-agent
    nohup node server.mjs >> /var/log/rangerai-agent.log 2>&1 &
    NEW_PID=$!
    echo "Started new process: PID $NEW_PID"
    sleep 3
    
    # Verify
    if kill -0 $NEW_PID 2>/dev/null; then
        echo "✓ Server is running (PID $NEW_PID)"
        curl -s http://localhost:3001/health | python3 -m json.tool 2>/dev/null || echo "Health check pending..."
    else
        echo "✗ Server failed to start!"
        tail -20 /var/log/rangerai-agent.log
        exit 1
    fi
fi

echo "[$(date)] Restart complete."

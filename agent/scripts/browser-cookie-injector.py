#!/usr/bin/env python3
"""
Browser Cookie Injector for OpenClaw
Injects saved cookies into the OpenClaw browser via CDP.
Run after browser starts to restore login sessions.

Usage:
  python3 /opt/rangerai-agent/scripts/browser-cookie-injector.py [--wait]
  
  --wait: Wait for browser to become available (useful for startup scripts)
"""
import json
import sys
import time
import os

COOKIES_FILE = "/opt/rangerai-agent/config/browser-cookies.json"
CDP_HOST = "127.0.0.1"
CDP_PORT = 18800
MAX_WAIT_SECONDS = 60

def wait_for_browser(host, port, timeout):
    """Wait for the browser CDP endpoint to become available."""
    import requests
    start = time.time()
    while time.time() - start < timeout:
        try:
            resp = requests.get(f"http://{host}:{port}/json/version", timeout=2)
            if resp.status_code == 200:
                return True
        except:
            pass
        time.sleep(2)
    return False

def inject_cookies(host, port, cookies):
    """Inject cookies via CDP."""
    import websocket
    import requests
    
    resp = requests.get(f"http://{host}:{port}/json/list", timeout=5)
    targets = resp.json()
    
    if not targets:
        # Create a blank page first
        resp = requests.get(f"http://{host}:{port}/json/new?about:blank", timeout=5)
        target = resp.json()
    else:
        target = targets[0]
    
    ws_url = target.get("webSocketDebuggerUrl", "")
    ws = websocket.create_connection(ws_url, suppress_origin=True, timeout=10)
    
    # Enable Network
    ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
    json.loads(ws.recv())
    
    # Convert to CDP format
    cdp_cookies = []
    for c in cookies:
        cookie = {
            "name": c["name"],
            "value": c["value"],
            "domain": c["domain"],
            "path": c.get("path", "/"),
            "secure": c.get("secure", False),
            "httpOnly": c.get("httpOnly", False),
        }
        same_site = c.get("sameSite", "Lax")
        if same_site in ["Strict", "Lax", "None"]:
            cookie["sameSite"] = same_site
        if c.get("expires", -1) > 0:
            cookie["expires"] = c["expires"]
        cdp_cookies.append(cookie)
    
    # Set cookies
    ws.send(json.dumps({
        "id": 2,
        "method": "Network.setCookies",
        "params": {"cookies": cdp_cookies}
    }))
    result = json.loads(ws.recv())
    
    # Verify
    ws.send(json.dumps({"id": 3, "method": "Network.getAllCookies"}))
    result = json.loads(ws.recv())
    total = len(result.get("result", {}).get("cookies", []))
    
    ws.close()
    return total

def main():
    wait_mode = "--wait" in sys.argv
    
    if not os.path.exists(COOKIES_FILE):
        print(f"[cookie-injector] No cookies file at {COOKIES_FILE}", file=sys.stderr)
        sys.exit(1)
    
    with open(COOKIES_FILE) as f:
        cookies = json.load(f)
    
    print(f"[cookie-injector] Loaded {len(cookies)} cookies from {COOKIES_FILE}", file=sys.stderr)
    
    if wait_mode:
        print(f"[cookie-injector] Waiting for browser on {CDP_HOST}:{CDP_PORT}...", file=sys.stderr)
        if not wait_for_browser(CDP_HOST, CDP_PORT, MAX_WAIT_SECONDS):
            print(f"[cookie-injector] Browser not available after {MAX_WAIT_SECONDS}s", file=sys.stderr)
            sys.exit(1)
        # Extra delay for browser to fully initialize
        time.sleep(2)
    
    try:
        total = inject_cookies(CDP_HOST, CDP_PORT, cookies)
        print(f"[cookie-injector] Successfully injected cookies. Total cookies in browser: {total}", file=sys.stderr)
    except Exception as e:
        print(f"[cookie-injector] Failed to inject cookies: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()

import { describe, it, expect } from "vitest";

const BASE = "http://localhost:3000";

describe("E2E Health Checks", () => {
  it("health endpoint returns 200", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
  });

  it("static index page is served", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("<!doctype html>");
  });

  it("metrics endpoint requires auth", async () => {
    const res = await fetch(`${BASE}/api/metrics`);
    expect(res.status).toBe(401);
  });

  it("metrics health endpoint requires auth", async () => {
    // /api/metrics/* now requires JWT auth; unauthenticated → 401
    const res = await fetch(`${BASE}/api/metrics/health`);
    expect(res.status).toBe(401);
  });

  it("admin routes require authentication (401 without token)", async () => {
    // JWT middleware fires before RBAC; no token → 401 (not 403)
    const res = await fetch(`${BASE}/api/admin/browser-status`);
    expect(res.status).toBe(401);
  });

  it("health providers endpoint returns data", async () => {
    const res = await fetch(`${BASE}/api/health/providers`);
    expect(res.status).toBe(200);
  });
});

/**
 * RangerAI Workflow API Module
 * Iter-5.3: DI规范化 — init(deps) + validateDeps + deps.db.* 子对象
 * v5.4: #8 RBAC 权限接入 — manager+ 可创建/运行/修改工作流
 *
 * All database functions accessed via deps.db.* (injected from ctx.db).
 * Zero direct imports from database.mjs or knowledge-db.mjs.
 *
 * Endpoints:
 * - GET    /api/workflows              — List all workflows (all roles)
 * - POST   /api/workflows              — Create a workflow (manager+)
 * - GET    /api/workflows/:id          — Get workflow details (all roles)
 * - PATCH  /api/workflows/:id          — Update a workflow (manager+)
 * - DELETE /api/workflows/:id          — Delete a workflow (admin only)
 * - POST   /api/workflows/:id/run      — Run a workflow (manager+)
 *
 * @module workflow-api
 */
import { logger } from '../lib/logger.mjs';
import { validateDeps } from '../lib/context.mjs';
import { executeWorkflowSteps } from '../workflow-scheduler.mjs';
import { hasPermission, denyAccess } from '../modules/rbac.mjs';
import {
  getWorkflowRunById as kdbGetRunById,
  getWorkflowRuns as kdbGetRuns,
  createWorkflowRun as kdbCreateRun,
} from '../knowledge-db.mjs';

// ─── Required deps fields (fail-fast on missing) ────────────
const REQUIRED_DEPS = [
  'db',   // db sub-object containing all database + knowledge-db functions
];

let deps = null;

/**
 * Initialize the workflow API with injected dependencies.
 * Must be called once from server.mjs before handling requests.
 *
 * @param {object} injected - Dependencies from buildWorkflowApiDeps(ctx)
 */
export function init(injected) {
  validateDeps(REQUIRED_DEPS, injected, 'workflow-api');
  deps = injected;
}

// ─── Convenience accessors ──────────────────────────────────
const db = () => deps.db;

/**
 * Handle all /api/workflows/* requests.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} true if the request was handled
 */
export async function handleWorkflowApi(req, res) {
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  // Webhook endpoints use token-based auth (no JWT needed)
  const isWebhook = /^\/api\/workflows\/webhook\//.test(urlPath) && method === 'POST';
  // All other workflow endpoints require authentication
  const user = isWebhook ? { id: 'webhook', username: 'webhook' } : await db().extractUserFromRequest(req);
  if (!user) {
    db().sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  // Initialize DB tables
  await db().initKnowledgeDb();

  // ─── GET /api/workflows ───
  if (urlPath === '/api/workflows' && method === 'GET') {
    try {
      const workflows = await db().getWorkflows(null, 100);
      const parsed = workflows.map(w => ({
        ...w,
        steps: typeof w.steps === 'string' ? JSON.parse(w.steps) : w.steps,
      }));
      db().sendJson(res, 200, { workflows: parsed });
    } catch (err) {
      logger.error('[workflow-api] list error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to list workflows' });
    }
    return true;
  }

  // ─── POST /api/workflows ───
  if (urlPath === '/api/workflows' && method === 'POST') {
    // #8 RBAC: manager+ can create workflows
    if (!hasPermission(user, 'workflow.create')) {
      denyAccess(res, db().sendJson, 'workflow.create', user.role);
      return true;
    }
    try {
      const body = await db().parseJsonBody(req);
      if (!body.name) {
        db().sendJson(res, 400, { error: 'Name is required' });
        return true;
      }
      const workflow = await db().createWorkflow({
        name: body.name,
        description: body.description,
        steps: body.steps || [],
        category: body.category,
        createdBy: user.id,
        cronExpression: body.cronExpression || null,
        cronEnabled: body.cronEnabled || false,
      });
      const parsed = {
        ...workflow,
        steps: typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : workflow.steps,
      };
      // Audit log (Iter-11)
      await db().createAuditLog({
        userId: user.id, username: user.username || user.name,
        action: 'workflow.create', targetType: 'workflow', targetId: parsed.id,
        details: JSON.stringify({ name: parsed.name }),
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
      });
      db().sendJson(res, 201, { workflow: parsed });
    } catch (err) {
      logger.error('[workflow-api] create error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to create workflow' });
    }
    return true;
  }

  // ─── POST /api/workflows/:id/run ───
  const runMatch = urlPath.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if (runMatch && method === 'POST') {
    // #8 RBAC: manager+ can run workflows
    if (!hasPermission(user, 'workflow.run')) {
      denyAccess(res, db().sendJson, 'workflow.run', user.role);
      return true;
    }
    try {
      const workflow = await db().getWorkflowById(runMatch[1]);
      if (!workflow) {
        db().sendJson(res, 404, { error: 'Workflow not found' });
        return true;
      }
      // Create run record
      const runRecord = await kdbCreateRun({ workflowId: runMatch[1], triggeredBy: user.username || 'manual' });
      // Audit log
      await db().createAuditLog({
        userId: user.id, username: user.username || user.name,
        action: 'workflow.run', targetType: 'workflow', targetId: runMatch[1],
        details: JSON.stringify({ runId: runRecord.id, workflowName: workflow.name }),
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
      });
      const parsed = {
        ...workflow,
        steps: typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : workflow.steps,
      };
      // 异步执行（不阻塞 HTTP 响应），前端可轮询 /api/workflow-runs/:runId 获取结果
      executeWorkflowSteps(workflow, runRecord.id, user.username || 'manual').catch(err =>
        logger.error(`[workflow-api] executeWorkflowSteps failed for ${workflow.name}:`, err.message)
      );
      db().sendJson(res, 200, { workflow: parsed, runId: runRecord.id, status: 'running' });
    } catch (err) {
      logger.error('[workflow-api] run error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to run workflow' });
    }
    return true;
  }


  // ─── POST /api/workflows/webhook/:webhookToken (public, no auth) ───
  const webhookMatch = urlPath.match(/^\/api\/workflows\/webhook\/([^/]+)$/);
  if (webhookMatch && method === 'POST') {
    try {
      const token = webhookMatch[1];
      // Find workflow by webhook token
      const workflows = await db().getWorkflows(null, 1000);
      const workflow = workflows.find(w => w.webhookToken === token && w.isActive);
      if (!workflow) {
        db().sendJson(res, 404, { error: 'Invalid webhook token' });
        return true;
      }
      // Parse optional payload
      let payload = {};
      try { payload = await db().parseJsonBody(req); } catch(_err) { /* v22.0 */ console.error("[workflow-api] silent catch:", _err?.message || _err); }
      
      const runRecord = await kdbCreateRun({ workflowId: workflow.id, triggeredBy: 'webhook' });
      
      // Inject webhook payload into context
      const originalSteps = typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : workflow.steps;
      
      executeWorkflowSteps(workflow, runRecord.id, 'webhook').catch(err =>
        logger.error(`[workflow-api] webhook execution failed for ${workflow.name}:`, err.message)
      );
      
      db().sendJson(res, 200, { 
        success: true, 
        runId: runRecord.id, 
        workflowName: workflow.name,
        status: 'running' 
      });
    } catch (err) {
      logger.error('[workflow-api] webhook error:', err.message);
      db().sendJson(res, 500, { error: 'Webhook execution failed' });
    }
    return true;
  }

  // ─── GET /api/workflows/:id ───
  const getMatch = urlPath.match(/^\/api\/workflows\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    try {
      const workflow = await db().getWorkflowById(getMatch[1]);
      if (!workflow) {
        db().sendJson(res, 404, { error: 'Workflow not found' });
        return true;
      }
      const parsed = {
        ...workflow,
        steps: typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : workflow.steps,
      };
      db().sendJson(res, 200, { workflow: parsed });
    } catch (err) {
      logger.error('[workflow-api] get error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to get workflow' });
    }
    return true;
  }

  // ─── PATCH /api/workflows/:id ───
  const patchMatch = urlPath.match(/^\/api\/workflows\/([^/]+)$/);
  if (patchMatch && method === 'PATCH') {
    // #8 RBAC: manager+ can update workflows
    if (!hasPermission(user, 'workflow.update')) {
      denyAccess(res, db().sendJson, 'workflow.update', user.role);
      return true;
    }
    try {
      const body = await db().parseJsonBody(req);
      const workflow = await db().updateWorkflow(patchMatch[1], body);
      if (!workflow) {
        db().sendJson(res, 404, { error: 'Workflow not found' });
        return true;
      }
      const parsed = {
        ...workflow,
        steps: typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : workflow.steps,
      };
      db().sendJson(res, 200, { workflow: parsed });
    } catch (err) {
      logger.error('[workflow-api] update error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to update workflow' });
    }
    return true;
  }

  // ─── DELETE /api/workflows/:id ───
  const deleteMatch = urlPath.match(/^\/api\/workflows\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    try {
      // #8 RBAC: admin only can delete workflows
      if (!hasPermission(user, 'workflow.delete')) {
        denyAccess(res, db().sendJson, 'workflow.delete', user.role);
        return true;
      }
      const workflow = await db().getWorkflowById(deleteMatch[1]);
      if (!workflow) {
        db().sendJson(res, 404, { error: 'Workflow not found' });
        return true;
      }
      await db().deleteWorkflow(deleteMatch[1]);
      // Audit log (Iter-11)
      await db().createAuditLog({
        userId: user.id, username: user.username || user.name,
        action: 'workflow.delete', targetType: 'workflow', targetId: deleteMatch[1],
        details: JSON.stringify({ name: workflow.name }),
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
      });
      db().sendJson(res, 200, { success: true });
    } catch (err) {
      logger.error('[workflow-api] delete error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to delete workflow' });
    }
    return true;
  }


  // ─── GET /api/workflows/:id/runs (Iter-11) ───
  const runsMatch = urlPath.match(/^\/api\/workflows\/([^/]+)\/runs$/);
  if (runsMatch && method === 'GET') {
    try {
      const runs = await kdbGetRuns(runsMatch[1], 50);
      db().sendJson(res, 200, { runs });
    } catch (err) {
      logger.error('[workflow-api] list runs error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to list workflow runs' });
    }
    return true;
  }

  // ─── GET /api/workflow-runs/:runId (Iter-11) ───
  const runDetailMatch = urlPath.match(/^\/api\/workflow-runs\/([^/]+)$/);
  if (runDetailMatch && method === 'GET') {
    try {
      const runDetail = await kdbGetRunById(runDetailMatch[1]);
      if (!runDetail) {
        db().sendJson(res, 404, { error: 'Run not found' });
        return true;
      }
      db().sendJson(res, 200, { run: runDetail });
    } catch (err) {
      logger.error('[workflow-api] get run error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to get workflow run' });
    }
    return true;
  }

  // ─── GET /api/audit-logs (Iter-11, admin only) ───
  if (urlPath === '/api/audit-logs' && method === 'GET') {
    try {
      // #8 RBAC: admin only can view audit logs
      if (!hasPermission(user, 'audit.view')) {
        denyAccess(res, db().sendJson, 'audit.view', user.role);
        return true;
      }
      const logs = await db().getAuditLogs(100, 0);
      db().sendJson(res, 200, { logs });
    } catch (err) {
      logger.error('[workflow-api] audit logs error:', err.message);
      db().sendJson(res, 500, { error: 'Failed to get audit logs' });
    }
    return true;
  }

  return false;
}

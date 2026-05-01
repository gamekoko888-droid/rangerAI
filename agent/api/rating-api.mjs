/**
 * Rating API — Anonymous Monthly Peer Review System
 * Routes: /api/rating/admin/* and /api/rating/h5/*
 */
import crypto from 'crypto';
import { query, queryOne, run } from '../db-adapter.mjs';
import { getDingtalkToken, dingtalkGet, dingtalkV1Get } from './dingtalk-helper.mjs';

// ── Constants ───────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.RATING_JWT_SECRET || process.env.JWT_SECRET || 'ranger-rating-secret-2026';
const ROLE_ORDER = { super_admin: 3, admin: 2, viewer: 1 };

// ── Utility ─────────────────────────────────────────────────────────────────
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

// ── Simple JWT (no external deps) ────────────────────────────────────────────
function jwtSign(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function jwtVerify(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (expected !== sig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Auth Middleware ───────────────────────────────────────────────────────────
async function requireRatingAdmin(req, res, minRole = 'viewer') {
  const auth = req.headers['authorization'] || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  // Also support ?token= query param (for direct download links)
  if (!token) {
    const urlObj = new URL(req.url, 'http://localhost');
    token = urlObj.searchParams.get('token');
  }
  if (!token) { sendJson(res, 401, { error: 'No token' }); return null; }
  const payload = jwtVerify(token);
  if (!payload) { sendJson(res, 401, { error: 'Invalid or expired token' }); return null; }
  const admin = await queryOne('SELECT * FROM rating_admin_users WHERE id=? AND is_active=1', [payload.adminId]);
  if (!admin) { sendJson(res, 401, { error: 'Admin not found' }); return null; }
  if ((ROLE_ORDER[admin.admin_role] || 0) < (ROLE_ORDER[minRole] || 0)) {
    sendJson(res, 403, { error: 'Insufficient permissions' }); return null;
  }
  return admin;
}

async function requireRatingSession(req, res) {
  const sessionToken = req.headers['x-rating-session'];
  if (!sessionToken) { sendJson(res, 401, { error: 'No session token' }); return null; }
  const tokenHash = sha256(sessionToken);
  const session = await queryOne(
    `SELECT s.*, v.campaign_id as vcampaign_id, v.group_id as vgroup_id, v.employee_id as vemployee_id, v.status as vstatus
     FROM rating_anon_sessions s
     JOIN rating_campaign_voters v ON v.id = s.voter_id
     WHERE s.session_token_hash=? AND s.expires_at > datetime('now') AND s.consumed_at IS NULL`,
    [tokenHash]
  );
  if (!session) { sendJson(res, 401, { error: 'Invalid or expired session' }); return null; }
  return session;
}

async function auditLog(adminId, action, targetType, targetId, detail, ip) {
  try {
    await run(
      'INSERT INTO rating_audit_logs (operator_admin_id, action, target_type, target_id, detail, ip) VALUES (?,?,?,?,?,?)',
      [adminId || null, action, targetType || null, targetId ? String(targetId) : null, detail ? JSON.stringify(detail) : null, ip || null]
    );
  } catch {}
}

// ── Main Handler ─────────────────────────────────────────────────────────────
export async function handleRatingApi(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const urlPath = urlObj.pathname;
  const method = req.method;
  const sp = urlObj.searchParams;

  if (!urlPath.startsWith('/api/rating/')) return false;

  // ── Health ──
  if (urlPath === '/api/rating/health') {
    sendJson(res, 200, { ok: true, service: 'rating' });
    return true;
  }

  // ── H5 匿名端 ─────────────────────────────────────────────────────────────
  if (urlPath === '/api/rating/h5/enter' && method === 'POST') {
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { entryToken } = body;
    if (!entryToken) { sendJson(res, 400, { error: 'entryToken required' }); return true; }

    const tokenHash = sha256(entryToken);
    const voter = await queryOne(
      `SELECT v.*, c.name as campaign_name, c.status as campaign_status
       FROM rating_campaign_voters v
       JOIN rating_campaigns c ON c.id = v.campaign_id
       WHERE v.entry_token_hash=?`,
      [tokenHash]
    );
    if (!voter) { sendJson(res, 404, { error: 'Invalid token' }); return true; }
    if (voter.status === 'used') { sendJson(res, 409, { error: 'Token already used' }); return true; }
    if (voter.status === 'voided') { sendJson(res, 410, { error: 'Token voided' }); return true; }
    if (voter.campaign_status !== 'active') { sendJson(res, 403, { error: 'Campaign not active' }); return true; }

    const memberCount = await queryOne(
      'SELECT COUNT(*) as cnt FROM rating_campaign_members WHERE campaign_id=? AND group_id=?',
      [voter.campaign_id, voter.group_id]
    );

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionHash = sha256(sessionToken);
    const expires = new Date(Date.now() + 2 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    await run(
      'INSERT INTO rating_anon_sessions (campaign_id, voter_id, session_token_hash, expires_at) VALUES (?,?,?,?)',
      [voter.campaign_id, voter.id, sessionHash, expires]
    );
    await run(
      `UPDATE rating_campaign_voters SET status='claimed', claimed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
      [voter.id]
    );

    sendJson(res, 200, {
      sessionToken,
      groupId: voter.group_id,
      campaignId: voter.campaign_id,
      campaignName: voter.campaign_name,
      memberCount: memberCount?.cnt || 0,
    });
    return true;
  }

  if (urlPath === '/api/rating/h5/form' && method === 'GET') {
    const session = await requireRatingSession(req, res);
    if (!session) return true;

    const members = await query(
      `SELECT id, employee_name as name FROM rating_campaign_members
       WHERE campaign_id=? AND group_id=? ORDER BY sort_no, id`,
      [session.campaign_id, session.vgroup_id]
    );
    const campaign = await queryOne('SELECT name, month_key FROM rating_campaigns WHERE id=?', [session.campaign_id]);
    sendJson(res, 200, { members, campaign });
    return true;
  }

  if (urlPath === '/api/rating/h5/submit' && method === 'POST') {
    const session = await requireRatingSession(req, res);
    if (!session) return true;

    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { impressionScores, hygieneScores } = body;

    // Validate required fields
    if (!Array.isArray(impressionScores) || !Array.isArray(hygieneScores)) {
      sendJson(res, 400, { error: 'impressionScores and hygieneScores arrays required' }); return true;
    }

    // Get all members in this group for this campaign
    const members = await query(
      'SELECT id FROM rating_campaign_members WHERE campaign_id=? AND group_id=?',
      [session.campaign_id, session.vgroup_id]
    );
    const memberIds = new Set(members.map(m => m.id));
    const N = members.length;

    // Validate impression scores: 1..N, no duplicate ranks, all members covered
    if (impressionScores.length !== N) {
      sendJson(res, 400, { error: `impressionScores must have ${N} entries` }); return true;
    }
    const rankSet = new Set();
    for (const s of impressionScores) {
      if (!memberIds.has(s.memberId)) { sendJson(res, 400, { error: `Invalid memberId: ${s.memberId}` }); return true; }
      if (!Number.isInteger(s.rankScore) || s.rankScore < 1 || s.rankScore > N) {
        sendJson(res, 400, { error: `rankScore must be 1-${N}` }); return true;
      }
      if (rankSet.has(s.rankScore)) { sendJson(res, 400, { error: `Duplicate rankScore: ${s.rankScore}` }); return true; }
      rankSet.add(s.rankScore);
    }

    // Validate hygiene scores: 1-100, all members covered
    if (hygieneScores.length !== N) {
      sendJson(res, 400, { error: `hygieneScores must have ${N} entries` }); return true;
    }
    for (const s of hygieneScores) {
      if (!memberIds.has(s.memberId)) { sendJson(res, 400, { error: `Invalid memberId: ${s.memberId}` }); return true; }
      if (!Number.isInteger(s.score) || s.score < 1 || s.score > 100) {
        sendJson(res, 400, { error: 'score must be 1-100 integer' }); return true;
      }
    }

    // Check all members covered by both score arrays
    const impMemberIds = new Set(impressionScores.map(s => s.memberId));
    const hygMemberIds = new Set(hygieneScores.map(s => s.memberId));
    for (const mid of memberIds) {
      if (!impMemberIds.has(mid) || !hygMemberIds.has(mid)) {
        sendJson(res, 400, { error: `Member ${mid} missing from scores` }); return true;
      }
    }

    const batchUuid = crypto.randomUUID();
    const ipRaw = getClientIp(req);
    const ipHash = ipRaw ? sha256(ipRaw) : null;

    await run(
      'INSERT INTO rating_submission_batches (batch_uuid, campaign_id, group_id, member_count, ip_hash) VALUES (?,?,?,?,?)',
      [batchUuid, session.campaign_id, session.vgroup_id, N, ipHash]
    );

    for (const s of impressionScores) {
      await run(
        'INSERT INTO rating_impression_scores (batch_uuid, target_member_id, rank_score) VALUES (?,?,?)',
        [batchUuid, s.memberId, s.rankScore]
      );
    }
    for (const s of hygieneScores) {
      await run(
        'INSERT INTO rating_hygiene_scores (batch_uuid, target_member_id, score) VALUES (?,?,?)',
        [batchUuid, s.memberId, s.score]
      );
    }

    // Mark session consumed and voter used
    await run(
      `UPDATE rating_anon_sessions SET consumed_at=datetime('now') WHERE id=?`,
      [session.id]
    );
    await run(
      `UPDATE rating_campaign_voters SET status='used', used_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
      [session.voter_id]
    );

    sendJson(res, 200, { ok: true });
    return true;
  }

  if (urlPath === '/api/rating/h5/status' && method === 'GET') {
    const sessionToken = req.headers['x-rating-session'];
    if (!sessionToken) { sendJson(res, 401, { error: 'No session token' }); return true; }
    const tokenHash = sha256(sessionToken);
    const session = await queryOne(
      'SELECT * FROM rating_anon_sessions WHERE session_token_hash=?',
      [tokenHash]
    );
    if (!session) { sendJson(res, 404, { error: 'Session not found' }); return true; }
    sendJson(res, 200, {
      consumed: !!session.consumed_at,
      expired: new Date(session.expires_at) < new Date(),
      consumedAt: session.consumed_at,
    });
    return true;
  }

  // ── Admin 认证 ─────────────────────────────────────────────────────────────
  if (urlPath === '/api/rating/admin/login' && method === 'POST') {
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { username, password } = body;
    if (!username || !password) { sendJson(res, 400, { error: 'username and password required' }); return true; }

    const admin = await queryOne('SELECT * FROM rating_admin_users WHERE username=? AND is_active=1', [username]);
    if (!admin) { sendJson(res, 401, { error: 'Invalid credentials' }); return true; }

    const hash = sha256(password);
    if (hash !== admin.password_hash) { sendJson(res, 401, { error: 'Invalid credentials' }); return true; }

    const token = jwtSign({
      adminId: admin.id,
      username: admin.username,
      role: admin.admin_role,
      managedGroupId: admin.managed_group_id,
      exp: Math.floor(Date.now() / 1000) + 86400, // 24h
    });

    await run(`UPDATE rating_admin_users SET last_login_at=datetime('now') WHERE id=?`, [admin.id]);
    await auditLog(admin.id, 'login', 'admin', admin.id, null, getClientIp(req));

    sendJson(res, 200, {
      ok: true,
      token,
      admin: { id: admin.id, username: admin.username, realName: admin.real_name, role: admin.admin_role, managedGroupId: admin.managed_group_id },
    });
    return true;
  }

  if (urlPath === '/api/rating/admin/me' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    sendJson(res, 200, {
      id: admin.id, username: admin.username, realName: admin.real_name,
      role: admin.admin_role, managedGroupId: admin.managed_group_id,
    });
    return true;
  }

  // ── 组织架构同步 ─────────────────────────────────────────────────────────────
  if (urlPath === '/api/rating/admin/org/sync' && method === 'POST') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;

    try {
      const token = await getDingtalkToken();
      let totalDepts = 0, totalEmps = 0, failedDepts = 0, failedEmps = 0;

      // Sync departments (fetch dept list recursively from root)
      const deptRes = await dingtalkGet(token, '/department/list', { fetch_child: 'true' });
      const depts = deptRes.department || [];

      for (const dept of depts) {
        try {
          await run(
            `INSERT INTO rating_departments (dingtalk_dept_id, name, dept_path, is_active)
             VALUES (?, ?, ?, 1)
             ON CONFLICT(dingtalk_dept_id) DO UPDATE SET name=excluded.name, updated_at=datetime('now')`,
            [String(dept.id), dept.name, dept.name]
          );
          totalDepts++;
        } catch { failedDepts++; }
      }

      // Sync employees for each department
      for (const dept of depts) {
        try {
          const dbDept = await queryOne('SELECT id FROM rating_departments WHERE dingtalk_dept_id=?', [String(dept.id)]);
          if (!dbDept) continue;

          let offset = 0;
          let hasMore = true;
          while (hasMore) {
            const empRes = await dingtalkGet(token, '/user/simplelist', {
              department_id: dept.id, offset, size: 100
            });
            const userIds = (empRes.userlist || []).map(u => u.userid);
            hasMore = empRes.hasMore === true;
            offset += userIds.length;

            for (const uid of userIds) {
              try {
                const userRes = await dingtalkGet(token, '/user/get', { userid: uid });
                if (userRes.errcode !== 0) continue;
                const u = userRes;
                const mobile = u.mobile ? `${u.mobile.slice(0, 3)}****${u.mobile.slice(-4)}` : null;
                await run(
                  `INSERT INTO rating_employees (dingtalk_user_id, job_no, name, mobile_mask, email, department_id, employment_status)
                   VALUES (?, ?, ?, ?, ?, ?, 1)
                   ON CONFLICT(dingtalk_user_id) DO UPDATE SET
                     name=excluded.name, job_no=excluded.job_no, email=excluded.email,
                     mobile_mask=excluded.mobile_mask, department_id=excluded.department_id,
                     updated_at=datetime('now')`,
                  [uid, u.jobnumber || null, u.name, mobile, u.email || null, dbDept.id]
                );
                totalEmps++;
              } catch { failedEmps++; }
            }
          }
        } catch {}
      }

      const syncStatus = (failedDepts + failedEmps === 0) ? 'success' : ((totalDepts + totalEmps > 0) ? 'partial' : 'failed');
      await run(
        'INSERT INTO rating_org_sync_logs (sync_type, sync_status, total_count, success_count, failed_count, message) VALUES (?,?,?,?,?,?)',
        ['full', syncStatus, totalDepts + totalEmps, totalDepts + totalEmps - failedDepts - failedEmps, failedDepts + failedEmps, null]
      );
      await auditLog(admin.id, 'org_sync', 'org', null, { depts: totalDepts, emps: totalEmps }, getClientIp(req));

      sendJson(res, 200, { ok: true, depts: totalDepts, employees: totalEmps, failedDepts, failedEmps });
    } catch (err) {
      await run(
        'INSERT INTO rating_org_sync_logs (sync_type, sync_status, total_count, success_count, failed_count, message) VALUES (?,?,0,0,0,?)',
        ['full', 'failed', err.message]
      );
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  if (urlPath === '/api/rating/admin/org/departments' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const rows = await query('SELECT * FROM rating_departments WHERE is_active=1 ORDER BY name', []);
    sendJson(res, 200, { departments: rows });
    return true;
  }

  if (urlPath === '/api/rating/admin/org/employees' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const groupId = sp.get('groupId');
    const search = sp.get('search');
    let sql = 'SELECT e.*, d.name as dept_name, g.name as group_name FROM rating_employees e LEFT JOIN rating_departments d ON d.id=e.department_id LEFT JOIN rating_groups g ON g.id=e.group_id WHERE e.employment_status=1';
    const params = [];
    if (groupId) { sql += ' AND e.group_id=?'; params.push(parseInt(groupId)); }
    if (search) { sql += ' AND e.name LIKE ?'; params.push(`%${search}%`); }
    sql += ' ORDER BY e.name LIMIT 200';
    const rows = await query(sql, params);
    sendJson(res, 200, { employees: rows });
    return true;
  }

  // ── 小组管理 ─────────────────────────────────────────────────────────────────
  if (urlPath === '/api/rating/admin/groups' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const rows = await query(
      `SELECT g.*, d.name as dept_name, e.name as leader_name,
        (SELECT COUNT(*) FROM rating_employees emp WHERE emp.group_id=g.id AND emp.employment_status=1) as member_count
       FROM rating_groups g
       LEFT JOIN rating_departments d ON d.id=g.department_id
       LEFT JOIN rating_employees e ON e.id=g.leader_employee_id
       WHERE g.is_active=1 ORDER BY g.name`, []
    );
    sendJson(res, 200, { groups: rows });
    return true;
  }

  if (urlPath === '/api/rating/admin/groups' && method === 'POST') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { name, departmentId, leaderEmployeeId, remark } = body;
    if (!name) { sendJson(res, 400, { error: 'name required' }); return true; }
    const result = await run(
      'INSERT INTO rating_groups (name, department_id, leader_employee_id, remark) VALUES (?,?,?,?)',
      [name, departmentId || null, leaderEmployeeId || null, remark || null]
    );
    await auditLog(admin.id, 'create_group', 'group', result.lastInsertRowid, { name }, getClientIp(req));
    sendJson(res, 200, { ok: true, id: result.lastInsertRowid });
    return true;
  }

  const groupUpdateMatch = urlPath.match(/^\/api\/rating\/admin\/groups\/(\d+)$/);
  if (groupUpdateMatch && method === 'PUT') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;
    const gid = parseInt(groupUpdateMatch[1]);
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const fields = [];
    const params = [];
    if (body.name !== undefined) { fields.push('name=?'); params.push(body.name); }
    if (body.departmentId !== undefined) { fields.push('department_id=?'); params.push(body.departmentId || null); }
    if (body.leaderEmployeeId !== undefined) { fields.push('leader_employee_id=?'); params.push(body.leaderEmployeeId || null); }
    if (body.remark !== undefined) { fields.push('remark=?'); params.push(body.remark); }
    if (body.isActive !== undefined) { fields.push('is_active=?'); params.push(body.isActive ? 1 : 0); }
    if (fields.length === 0) { sendJson(res, 400, { error: 'No fields to update' }); return true; }
    fields.push("updated_at=datetime('now')");
    params.push(gid);
    await run(`UPDATE rating_groups SET ${fields.join(',')} WHERE id=?`, params);
    await auditLog(admin.id, 'update_group', 'group', gid, body, getClientIp(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── 删除小组 ────────────────────────────────────────────────────────────────
  const groupDeleteMatch = urlPath.match(/^\/api\/rating\/admin\/groups\/(\d+)$/);
  if (groupDeleteMatch && method === 'DELETE') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;
    const gid = parseInt(groupDeleteMatch[1]);
    const grp = await queryOne('SELECT * FROM rating_groups WHERE id=?', [gid]);
    if (!grp) { sendJson(res, 404, { error: 'Group not found' }); return true; }
    // Check if group has active campaigns
    const activeCampaign = await queryOne(
      "SELECT id FROM rating_campaigns WHERE target_group_id=? AND status='active'", [gid]
    );
    if (activeCampaign) { sendJson(res, 409, { error: '该小组存在进行中的活动，无法删除' }); return true; }
    // Remove group members from employees (set group_id to null)
    await run('UPDATE rating_employees SET group_id=NULL WHERE group_id=?', [gid]);
    await run('DELETE FROM rating_groups WHERE id=?', [gid]);
    await auditLog(admin.id, 'delete_group', 'group', gid, { name: grp.name }, getClientIp(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  const groupMembersMatch = urlPath.match(/^\/api\/rating\/admin\/groups\/(\d+)\/members$/);
  if (groupMembersMatch && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const gid = parseInt(groupMembersMatch[1]);
    const rows = await query(
      'SELECT e.*, d.name as dept_name FROM rating_employees e LEFT JOIN rating_departments d ON d.id=e.department_id WHERE e.group_id=? AND e.employment_status=1 ORDER BY e.name',
      [gid]
    );
    sendJson(res, 200, { members: rows });
    return true;
  }

  if (groupMembersMatch && method === 'POST') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;
    const gid = parseInt(groupMembersMatch[1]);
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { employeeIds } = body;
    if (!Array.isArray(employeeIds)) { sendJson(res, 400, { error: 'employeeIds array required' }); return true; }
    // Unassign existing members of this group
    await run('UPDATE rating_employees SET group_id=NULL WHERE group_id=?', [gid]);
    // Assign new members
    for (const eid of employeeIds) {
      await run('UPDATE rating_employees SET group_id=? WHERE id=?', [gid, eid]);
    }
    await auditLog(admin.id, 'set_group_members', 'group', gid, { employeeIds }, getClientIp(req));
    sendJson(res, 200, { ok: true, assigned: employeeIds.length });
    return true;
  }

  // ── 评分活动管理 ──────────────────────────────────────────────────────────────
  if (urlPath === '/api/rating/admin/campaigns' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const rows = await query(
      `SELECT c.*,
        g.name as target_group_name,
        (SELECT COUNT(*) FROM rating_campaign_voters v WHERE v.campaign_id=c.id AND v.status='used') as voted_count,
        (SELECT COUNT(*) FROM rating_campaign_voters v WHERE v.campaign_id=c.id) as total_voters
       FROM rating_campaigns c
       LEFT JOIN rating_groups g ON g.id=c.target_group_id
       ORDER BY c.created_at DESC`, []
    );
    sendJson(res, 200, { campaigns: rows });
    return true;
  }

  if (urlPath === '/api/rating/admin/campaigns' && method === 'POST') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { name, monthKey, startAt, endAt, targetGroupId } = body;
    if (!name || !monthKey || !startAt || !endAt) { sendJson(res, 400, { error: 'name, monthKey, startAt, endAt required' }); return true; }
    // Validate targetGroupId if provided
    if (targetGroupId) {
      const grp = await queryOne('SELECT id FROM rating_groups WHERE id=? AND is_active=1', [targetGroupId]);
      if (!grp) { sendJson(res, 400, { error: '指定小组不存在或已禁用' }); return true; }
    }
    let result;
    try {
      result = await run(
        'INSERT INTO rating_campaigns (name, month_key, start_at, end_at, created_by, target_group_id) VALUES (?,?,?,?,?,?)',
        [name, monthKey, startAt, endAt, admin.id, targetGroupId || null]
      );
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        sendJson(res, 409, { error: `月份 ${monthKey} 已存在评分活动，每月只能创建一个活动。如需重新创建，请先删除该月份的旧活动。` });
        return true;
      }
      throw err;
    }
    await auditLog(admin.id, 'create_campaign', 'campaign', result.lastInsertRowid, { name, monthKey, targetGroupId }, getClientIp(req));
    sendJson(res, 200, { ok: true, id: result.lastInsertRowid });
    return true;
  }

  // ── 删除活动（仅 draft 状态可删）─────────────────────────────────────────
  const campaignDeleteMatch = urlPath.match(/^\/api\/rating\/admin\/campaigns\/(\d+)$/);
  if (campaignDeleteMatch && method === 'DELETE') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;
    const cid = parseInt(campaignDeleteMatch[1]);
    const campaign = await queryOne('SELECT * FROM rating_campaigns WHERE id=?', [cid]);
    if (!campaign) { sendJson(res, 404, { error: 'Campaign not found' }); return true; }
    // Allow deletion for draft and closed campaigns (not active)
    if (campaign.status === 'active') { sendJson(res, 409, { error: '活动进行中，无法删除。请先关闭活动再删除。' }); return true; }
    // Delete scores via batch_uuid (no direct campaign_id on score tables)
    const batches = await query('SELECT batch_uuid FROM rating_submission_batches WHERE campaign_id=?', [cid]);
    for (const b of batches) {
      await run('DELETE FROM rating_impression_scores WHERE batch_uuid=?', [b.batch_uuid]);
      await run('DELETE FROM rating_hygiene_scores WHERE batch_uuid=?', [b.batch_uuid]);
    }
    await run('DELETE FROM rating_submission_batches WHERE campaign_id=?', [cid]);
    await run('DELETE FROM rating_anon_sessions WHERE campaign_id=?', [cid]);
    await run('DELETE FROM rating_claim_records WHERE campaign_id=?', [cid]);
    await run('DELETE FROM rating_campaign_members WHERE campaign_id=?', [cid]);
    await run('DELETE FROM rating_campaign_voters WHERE campaign_id=?', [cid]);
    await run('DELETE FROM rating_campaigns WHERE id=?', [cid]);
    await auditLog(admin.id, 'delete_campaign', 'campaign', cid, { name: campaign.name }, getClientIp(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  const campaignActivateMatch = urlPath.match(/^\/api\/rating\/admin\/campaigns\/(\d+)\/activate$/);
  if (campaignActivateMatch && method === 'PUT') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;
    const cid = parseInt(campaignActivateMatch[1]);
    const campaign = await queryOne('SELECT * FROM rating_campaigns WHERE id=?', [cid]);
    if (!campaign) { sendJson(res, 404, { error: 'Campaign not found' }); return true; }
    if (campaign.status !== 'draft') { sendJson(res, 409, { error: 'Campaign is not in draft status' }); return true; }

    // Snapshot groups' members into rating_campaign_members (all or target group only)
    const groupsQuery = campaign.target_group_id
      ? 'SELECT * FROM rating_groups WHERE id=? AND is_active=1'
      : 'SELECT * FROM rating_groups WHERE is_active=1';
    const groupsParams = campaign.target_group_id ? [campaign.target_group_id] : [];
    const groups = await query(groupsQuery, groupsParams);
    const votersList = [];

    for (const group of groups) {
      const emps = await query(
        'SELECT * FROM rating_employees WHERE group_id=? AND employment_status=1',
        [group.id]
      );
      let sortNo = 0;
      for (const emp of emps) {
        // Insert into campaign_members (ignore if exists)
        try {
          await run(
            'INSERT OR IGNORE INTO rating_campaign_members (campaign_id, group_id, employee_id, employee_name, sort_no) VALUES (?,?,?,?,?)',
            [cid, group.id, emp.id, emp.name, sortNo++]
          );
        } catch {}

        // Generate entry_token
        const entryToken = crypto.randomBytes(32).toString('hex');
        const entryTokenHash = sha256(entryToken);
        const empSecret = process.env.RATING_EMP_SECRET || 'ranger-emp-2026';
        const employeeHash = sha256(`${emp.id}:${cid}:${empSecret}`);

        await run(
          'INSERT OR IGNORE INTO rating_campaign_voters (campaign_id, employee_id, group_id, employee_hash, entry_token, entry_token_hash) VALUES (?,?,?,?,?,?)',
          [cid, emp.id, group.id, employeeHash, entryToken, entryTokenHash]
        );
        votersList.push({ employeeId: emp.id, employeeName: emp.name, groupId: group.id, groupName: group.name, entryToken });
      }
    }

    // Generate public entry code (8-char alphanumeric, uppercase)
    const entryCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    await run(`UPDATE rating_campaigns SET status='active', public_entry_code=?, updated_at=datetime('now') WHERE id=?`, [entryCode, cid]);
    await auditLog(admin.id, 'activate_campaign', 'campaign', cid, { voters: votersList.length, entryCode }, getClientIp(req));

    sendJson(res, 200, { ok: true, voters: votersList, entryCode });
    return true;
  }

  const campaignCloseMatch = urlPath.match(/^\/api\/rating\/admin\/campaigns\/(\d+)\/close$/);
  if (campaignCloseMatch && method === 'PUT') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;
    const cid = parseInt(campaignCloseMatch[1]);
    await run(`UPDATE rating_campaigns SET status='closed', updated_at=datetime('now') WHERE id=?`, [cid]);
    await auditLog(admin.id, 'close_campaign', 'campaign', cid, null, getClientIp(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── 跨组成员管理 ───────────────────────────────────────────────────────────
  const crossGroupMatch = urlPath.match(/^\/api\/rating\/admin\/campaigns\/(\d+)\/cross-group$/);
  if (crossGroupMatch && method === 'POST') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;
    const cid = parseInt(crossGroupMatch[1]);
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { groupId, employeeId } = body;
    if (!groupId || !employeeId) { sendJson(res, 400, { error: 'groupId and employeeId required' }); return true; }

    const emp = await queryOne('SELECT * FROM rating_employees WHERE id=?', [employeeId]);
    if (!emp) { sendJson(res, 404, { error: 'Employee not found' }); return true; }

    const memberCount = await queryOne(
      'SELECT COUNT(*) as cnt FROM rating_campaign_members WHERE campaign_id=? AND group_id=?',
      [cid, groupId]
    );
    await run(
      'INSERT OR IGNORE INTO rating_campaign_members (campaign_id, group_id, employee_id, employee_name, is_cross_group, added_by_admin, sort_no) VALUES (?,?,?,?,1,?,?)',
      [cid, groupId, employeeId, emp.name, admin.id, (memberCount?.cnt || 0) + 1]
    );

    // Generate token for cross-group voter
    const entryToken = crypto.randomBytes(32).toString('hex');
    const entryTokenHash = sha256(entryToken);
    const empSecret = process.env.RATING_EMP_SECRET || 'ranger-emp-2026';
    const employeeHash = sha256(`${employeeId}:${cid}:${empSecret}`);
    await run(
      'INSERT OR IGNORE INTO rating_campaign_voters (campaign_id, employee_id, group_id, employee_hash, entry_token, entry_token_hash) VALUES (?,?,?,?,?,?)',
      [cid, employeeId, groupId, employeeHash, entryToken, entryTokenHash]
    );

    await auditLog(admin.id, 'cross_group_add', 'campaign', cid, { groupId, employeeId }, getClientIp(req));
    sendJson(res, 200, { ok: true, entryToken });
    return true;
  }

  // ── 令牌管理 ──────────────────────────────────────────────────────────────
  const campaignVotersMatch = urlPath.match(/^\/api\/rating\/admin\/campaigns\/(\d+)\/voters$/);
  if (campaignVotersMatch && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const cid = parseInt(campaignVotersMatch[1]);
    const filterGroupId = sp.get('groupId');

    let sql = `SELECT v.*, e.name as employee_name, g.name as group_name
               FROM rating_campaign_voters v
               JOIN rating_employees e ON e.id=v.employee_id
               JOIN rating_groups g ON g.id=v.group_id
               WHERE v.campaign_id=?`;
    const params = [cid];

    // Sub-admin can only see their own group
    if (admin.admin_role !== 'super_admin' && admin.managed_group_id) {
      sql += ' AND v.group_id=?';
      params.push(admin.managed_group_id);
    } else if (filterGroupId) {
      sql += ' AND v.group_id=?';
      params.push(parseInt(filterGroupId));
    }
    sql += ' ORDER BY g.name, e.name';

    const rows = await query(sql, params);
    // Never return the actual entry_token in list view - return only status info
    sendJson(res, 200, {
      voters: rows.map(r => ({
        id: r.id, campaignId: r.campaign_id, employeeId: r.employee_id,
        employeeName: r.employee_name, groupId: r.group_id, groupName: r.group_name,
        status: r.status, claimedAt: r.claimed_at, usedAt: r.used_at, createdAt: r.created_at,
      }))
    });
    return true;
  }

  const voterResetMatch = urlPath.match(/^\/api\/rating\/admin\/voters\/(\d+)\/reset$/);
  if (voterResetMatch && method === 'PUT') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;
    const vid = parseInt(voterResetMatch[1]);
    const voter = await queryOne('SELECT * FROM rating_campaign_voters WHERE id=?', [vid]);
    if (!voter) { sendJson(res, 404, { error: 'Voter not found' }); return true; }
    if (voter.status === 'used') { sendJson(res, 409, { error: 'Already voted, cannot reset' }); return true; }

    const entryToken = crypto.randomBytes(32).toString('hex');
    const entryTokenHash = sha256(entryToken);
    await run(
      `UPDATE rating_campaign_voters SET entry_token=?, entry_token_hash=?, status='unused', claimed_at=NULL, used_at=NULL, updated_at=datetime('now') WHERE id=?`,
      [entryToken, entryTokenHash, vid]
    );
    await auditLog(admin.id, 'reset_voter', 'voter', vid, null, getClientIp(req));
    sendJson(res, 200, { ok: true, entryToken });
    return true;
  }

  const voterVoidMatch = urlPath.match(/^\/api\/rating\/admin\/voters\/(\d+)\/void$/);
  if (voterVoidMatch && method === 'PUT') {
    const admin = await requireRatingAdmin(req, res, 'admin');
    if (!admin) return true;
    const vid = parseInt(voterVoidMatch[1]);
    await run(`UPDATE rating_campaign_voters SET status='voided', updated_at=datetime('now') WHERE id=?`, [vid]);
    await auditLog(admin.id, 'void_voter', 'voter', vid, null, getClientIp(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── 结果报表 ───────────────────────────────────────────────────────────────
  const resultsMatch = urlPath.match(/^\/api\/rating\/admin\/campaigns\/(\d+)\/results$/);
  if (resultsMatch && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const cid = parseInt(resultsMatch[1]);

    let groupFilter = '';
    const params = [cid];
    if (admin.admin_role !== 'super_admin' && admin.managed_group_id) {
      groupFilter = ' AND cm.group_id=?';
      params.push(admin.managed_group_id);
    } else if (sp.get('groupId')) {
      groupFilter = ' AND cm.group_id=?';
      params.push(parseInt(sp.get('groupId')));
    }

    const results = await query(
      `SELECT
        cm.id as member_id, cm.employee_name as name, cm.group_id,
        g.name as group_name,
        ROUND(AVG(imp.rank_score), 2) as avg_impression_score,
        ROUND(AVG(hyg.score), 2) as avg_hygiene_score,
        COUNT(DISTINCT imp.batch_uuid) as submission_count
       FROM rating_campaign_members cm
       JOIN rating_groups g ON g.id=cm.group_id
       LEFT JOIN rating_impression_scores imp ON imp.target_member_id=cm.id
       LEFT JOIN rating_hygiene_scores hyg ON hyg.target_member_id=cm.id
       WHERE cm.campaign_id=?${groupFilter}
       GROUP BY cm.id
       ORDER BY g.name, cm.sort_no, cm.id`,
      params
    );
    sendJson(res, 200, { results });
    return true;
  }

  // ── 导出 XLSX ──────────────────────────────────────────────────────────────
  const exportMatch = urlPath.match(/^\/api\/rating\/admin\/campaigns\/(\d+)\/results\/export$/);
  if (exportMatch && method === 'GET') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;
    const cid = parseInt(exportMatch[1]);

    const campaign = await queryOne('SELECT * FROM rating_campaigns WHERE id=?', [cid]);
    if (!campaign) { sendJson(res, 404, { error: 'Campaign not found' }); return true; }

    const results = await query(
      `SELECT
        cm.id as member_id, cm.employee_name as name, cm.group_id,
        g.name as group_name,
        ROUND(AVG(imp.rank_score), 2) as avg_impression_score,
        ROUND(AVG(hyg.score), 2) as avg_hygiene_score,
        COUNT(DISTINCT imp.batch_uuid) as submission_count
       FROM rating_campaign_members cm
       JOIN rating_groups g ON g.id=cm.group_id
       LEFT JOIN rating_impression_scores imp ON imp.target_member_id=cm.id
       LEFT JOIN rating_hygiene_scores hyg ON hyg.target_member_id=cm.id
       WHERE cm.campaign_id=?
       GROUP BY cm.id
       ORDER BY g.name, cm.sort_no, cm.id`,
      [cid]
    );

    // Group by group_name
    const byGroup = {};
    for (const r of results) {
      if (!byGroup[r.group_name]) byGroup[r.group_name] = [];
      byGroup[r.group_name].push(r);
    }

    try {
      const XLSX = (await import('xlsx')).default;
      const wb = XLSX.utils.book_new();

      for (const [groupName, rows] of Object.entries(byGroup)) {
        const wsData = [
          ['姓名', '印象分均值', '卫生分均值', '提交人数'],
          ...rows.map(r => [r.name, r.avg_impression_score || 0, r.avg_hygiene_score || 0, r.submission_count || 0]),
        ];
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb, ws, groupName.slice(0, 31));
      }

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const filename = `rating-${campaign.month_key}-${Date.now()}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buf.length,
      });
      res.end(buf);
      await auditLog(admin.id, 'export_results', 'campaign', cid, null, getClientIp(req));
    } catch (err) {
      sendJson(res, 500, { error: `XLSX export failed: ${err.message}` });
    }
    return true;
  }

  // ── 管理员管理 ────────────────────────────────────────────────────────────
  if (urlPath === '/api/rating/admin/admins' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;
    const rows = await query(
      'SELECT id, username, real_name, admin_role, managed_group_id, is_active, last_login_at, created_at FROM rating_admin_users ORDER BY created_at', []
    );
    sendJson(res, 200, { admins: rows });
    return true;
  }

  if (urlPath === '/api/rating/admin/admins' && method === 'POST') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { username, password, realName, adminRole, managedGroupId } = body;
    if (!username || !password) { sendJson(res, 400, { error: 'username and password required' }); return true; }
    const validRoles = ['super_admin', 'admin', 'viewer'];
    if (adminRole && !validRoles.includes(adminRole)) { sendJson(res, 400, { error: 'Invalid adminRole' }); return true; }

    const hash = sha256(password);
    const result = await run(
      'INSERT INTO rating_admin_users (username, password_hash, real_name, admin_role, managed_group_id) VALUES (?,?,?,?,?)',
      [username, hash, realName || null, adminRole || 'admin', managedGroupId || null]
    );
    await auditLog(admin.id, 'create_admin', 'admin', result.lastInsertRowid, { username, adminRole }, getClientIp(req));
    sendJson(res, 200, { ok: true, id: result.lastInsertRowid });
    return true;
  }

  const adminUpdateMatch = urlPath.match(/^\/api\/rating\/admin\/admins\/(\d+)$/);
  if (adminUpdateMatch && method === 'PUT') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;
    const aid = parseInt(adminUpdateMatch[1]);
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }

    const fields = [];
    const params = [];
    if (body.realName !== undefined) { fields.push('real_name=?'); params.push(body.realName); }
    if (body.adminRole !== undefined) { fields.push('admin_role=?'); params.push(body.adminRole); }
    if (body.managedGroupId !== undefined) { fields.push('managed_group_id=?'); params.push(body.managedGroupId || null); }
    if (body.isActive !== undefined) { fields.push('is_active=?'); params.push(body.isActive ? 1 : 0); }
    if (body.password !== undefined) { fields.push('password_hash=?'); params.push(sha256(body.password)); }
    if (fields.length === 0) { sendJson(res, 400, { error: 'No fields to update' }); return true; }
    fields.push("updated_at=datetime('now')");
    params.push(aid);
    await run(`UPDATE rating_admin_users SET ${fields.join(',')} WHERE id=?`, params);
    await auditLog(admin.id, 'update_admin', 'admin', aid, { fields: Object.keys(body) }, getClientIp(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (adminUpdateMatch && method === 'DELETE') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;
    const aid = parseInt(adminUpdateMatch[1]);
    if (aid === admin.id) { sendJson(res, 400, { error: 'Cannot delete yourself' }); return true; }
    await run('DELETE FROM rating_admin_users WHERE id=?', [aid]);
    await auditLog(admin.id, 'delete_admin', 'admin', aid, null, getClientIp(req));
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── 审计日志 ──────────────────────────────────────────────────────────────
  if (urlPath === '/api/rating/admin/audit' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const page = Math.max(1, parseInt(sp.get('page') || '1'));
    const limit = Math.min(100, parseInt(sp.get('limit') || '50'));
    const offset = (page - 1) * limit;
    const rows = await query(
      `SELECT l.*, a.username as admin_username FROM rating_audit_logs l
       LEFT JOIN rating_admin_users a ON a.id=l.operator_admin_id
       ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const total = await queryOne('SELECT COUNT(*) as cnt FROM rating_audit_logs', []);
    sendJson(res, 200, { logs: rows, total: total?.cnt || 0, page, limit });
    return true;
  }

  // ── H5 自助领取（扫码→员工匹配→发令牌） ──────────────────────────────────
  // POST /api/rating/h5/self-claim
  // Body: { entryCode, employeeId }  OR  { entryCode, dingtalkUserId }
  if (urlPath === '/api/rating/h5/self-claim' && method === 'POST') {
    let body;
    try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const { entryCode, employeeId, dingtalkUserId } = body;

    if (!entryCode) { sendJson(res, 400, { error: 'entryCode required' }); return true; }
    if (!employeeId && !dingtalkUserId) { sendJson(res, 400, { error: 'employeeId or dingtalkUserId required' }); return true; }

    // Find active campaign by entry code
    const campaign = await queryOne(
      `SELECT * FROM rating_campaigns WHERE public_entry_code=? AND status='active'`,
      [entryCode.toUpperCase()]
    );
    if (!campaign) { sendJson(res, 404, { error: '活动不存在或已结束' }); return true; }

    // Resolve employee
    let emp;
    if (employeeId) {
      emp = await queryOne('SELECT e.*, d.name as dept_name, g.name as group_name FROM rating_employees e LEFT JOIN rating_departments d ON d.id=e.department_id LEFT JOIN rating_groups g ON g.id=e.group_id WHERE e.id=? AND e.employment_status=1', [employeeId]);
    } else {
      emp = await queryOne('SELECT e.*, d.name as dept_name, g.name as group_name FROM rating_employees e LEFT JOIN rating_departments d ON d.id=e.department_id LEFT JOIN rating_groups g ON g.id=e.group_id WHERE e.dingtalk_user_id=? AND e.employment_status=1', [dingtalkUserId]);
    }
    if (!emp) { sendJson(res, 404, { error: '未找到员工信息' }); return true; }
    if (!emp.group_id) { sendJson(res, 403, { error: '你尚未分配到评分小组，请联系管理员' }); return true; }

    // Check if already claimed (idempotent: return existing token)
    const existingClaim = await queryOne(
      'SELECT cr.*, v.entry_token, v.status as voter_status FROM rating_claim_records cr JOIN rating_campaign_voters v ON v.id=cr.voter_id WHERE cr.campaign_id=? AND cr.employee_id=?',
      [campaign.id, emp.id]
    );
    if (existingClaim) {
      // Return the existing entry token (allows re-entry if not yet used)
      if (existingClaim.voter_status === 'used') {
        sendJson(res, 409, { error: '你已完成本次评分，无法重复参与' });
        return true;
      }
      sendJson(res, 200, {
        entryToken: existingClaim.entry_token,
        campaignName: campaign.name,
        employeeName: emp.name,
        alreadyClaimed: true,
      });
      return true;
    }

    // Find their voter record (created during activate)
    const voter = await queryOne(
      'SELECT * FROM rating_campaign_voters WHERE campaign_id=? AND employee_id=? AND status!=?',
      [campaign.id, emp.id, 'voided']
    );
    if (!voter) { sendJson(res, 403, { error: '你不在本次评分活动的参与名单中' }); return true; }

    // Record claim (identity binding)
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';
    await run(
      `INSERT INTO rating_claim_records (campaign_id, voter_id, employee_id, real_name, dept_name, group_name, ip_address, user_agent) VALUES (?,?,?,?,?,?,?,?)`,
      [campaign.id, voter.id, emp.id, emp.name, emp.dept_name || '', emp.group_name || '', ip, ua.slice(0, 500)]
    );

    sendJson(res, 200, {
      entryToken: voter.entry_token,
      campaignName: campaign.name,
      employeeName: emp.name,
      alreadyClaimed: false,
    });
    return true;
  }

  // GET /api/rating/h5/active-campaign?code=XXXXXXXX
  if (urlPath === '/api/rating/h5/active-campaign' && method === 'GET') {
    const code = sp.get('code');
    if (!code) { sendJson(res, 400, { error: 'code required' }); return true; }
    const campaign = await queryOne(
      `SELECT id, name, month_key, start_at, end_at FROM rating_campaigns WHERE public_entry_code=? AND status='active'`,
      [code.toUpperCase()]
    );
    if (!campaign) { sendJson(res, 404, { error: '活动不存在或已结束' }); return true; }
    sendJson(res, 200, { campaign });
    return true;
  }

  // GET /api/rating/h5/employees?campaign_id=1 — 员工列表供自助选择
  if (urlPath === '/api/rating/h5/employees' && method === 'GET') {
    const cid = parseInt(sp.get('campaign_id') || '0');
    if (!cid) { sendJson(res, 400, { error: 'campaign_id required' }); return true; }
    const campaign = await queryOne(`SELECT id, status FROM rating_campaigns WHERE id=? AND status='active'`, [cid]);
    if (!campaign) { sendJson(res, 404, { error: '活动不存在或未激活' }); return true; }
    const emps = await query(
      `SELECT e.id, e.name, d.name as dept_name, g.name as group_name FROM rating_employees e
       LEFT JOIN rating_departments d ON d.id=e.department_id
       LEFT JOIN rating_groups g ON g.id=e.group_id
       WHERE e.employment_status=1 AND e.group_id IS NOT NULL
       ORDER BY g.name, e.name`,
      []
    );
    sendJson(res, 200, { employees: emps });
    return true;
  }

  // ── 超管审计溯源接口 ──────────────────────────────────────────────────────
  // GET /api/rating/admin/audit/score-attribution?campaign_id=1
  if (urlPath === '/api/rating/admin/audit/score-attribution' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res, 'super_admin');
    if (!admin) return true;

    const cid = parseInt(sp.get('campaign_id') || '0');
    if (!cid) { sendJson(res, 400, { error: 'campaign_id required' }); return true; }

    // Get all claim records for this campaign (who voted)
    const claims = await query(
      `SELECT cr.voter_id, cr.employee_id, cr.real_name, cr.dept_name, cr.group_name,
              cr.ip_address, cr.claimed_at, v.status as voter_status, v.used_at
       FROM rating_claim_records cr
       JOIN rating_campaign_voters v ON v.id=cr.voter_id
       WHERE cr.campaign_id=?
       ORDER BY cr.claimed_at`,
      [cid]
    );

    // Get impression scores with voter attribution
    const scores = await query(
      `SELECT sb.batch_uuid, sb.group_id, g.name as group_name,
              ims.target_member_id, cm.employee_name as target_name,
              ims.rank_score, sb.created_at as submitted_at,
              v.id as voter_id
       FROM rating_submission_batches sb
       JOIN rating_impression_scores ims ON ims.batch_uuid=sb.batch_uuid
       JOIN rating_campaign_members cm ON cm.id=ims.target_member_id
       JOIN rating_anon_sessions ans ON ans.campaign_id=sb.campaign_id AND ans.voter_id=(
         SELECT voter_id FROM rating_claim_records WHERE campaign_id=sb.campaign_id AND voter_id=(
           SELECT v2.id FROM rating_campaign_voters v2 WHERE v2.campaign_id=sb.campaign_id AND v2.group_id=sb.group_id AND v2.status='used' ORDER BY v2.used_at LIMIT 1
         )
       )
       LEFT JOIN rating_groups g ON g.id=sb.group_id
       WHERE sb.campaign_id=?
       ORDER BY sb.created_at`,
      [cid]
    );

    // Simpler attribution: join submission_batches → anon_sessions → claim_records
    const attributed = await query(
      `SELECT sb.batch_uuid, sb.group_id, g.name as group_name,
              cr.real_name as submitter_name, cr.dept_name as submitter_dept,
              cr.claimed_at, v.used_at as submitted_at,
              (SELECT COUNT(*) FROM rating_impression_scores WHERE batch_uuid=sb.batch_uuid) as score_count
       FROM rating_submission_batches sb
       JOIN rating_campaign_voters v ON v.campaign_id=sb.campaign_id AND v.group_id=sb.group_id AND v.status='used'
       LEFT JOIN rating_claim_records cr ON cr.voter_id=v.id AND cr.campaign_id=sb.campaign_id
       LEFT JOIN rating_groups g ON g.id=sb.group_id
       WHERE sb.campaign_id=?
       ORDER BY v.used_at`,
      [cid]
    );

    await auditLog(admin.id, 'view_score_attribution', 'campaign', cid, { accessed_at: new Date().toISOString() }, getClientIp(req));
    sendJson(res, 200, { claims, attributed });
    return true;
  }

  // ── Overview / Stats ──────────────────────────────────────────────────────
  if (urlPath === '/api/rating/admin/overview' && method === 'GET') {
    const admin = await requireRatingAdmin(req, res);
    if (!admin) return true;
    const campaigns = await query('SELECT * FROM rating_campaigns ORDER BY created_at DESC LIMIT 5', []);
    const groups = await queryOne('SELECT COUNT(*) as cnt FROM rating_groups WHERE is_active=1', []);
    const employees = await queryOne('SELECT COUNT(*) as cnt FROM rating_employees WHERE employment_status=1', []);
    sendJson(res, 200, { campaigns, groupCount: groups?.cnt || 0, employeeCount: employees?.cnt || 0 });
    return true;
  }

  return false;
}

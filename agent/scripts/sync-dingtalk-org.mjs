/**
 * sync-dingtalk-org.mjs
 * 从钉钉拉取最新组织架构，同步到 RangerAI departments + users 表
 * 运行：node /opt/rangerai-agent/scripts/sync-dingtalk-org.mjs
 */

import https from 'https';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mysql2 = require('/opt/rangerai-agent/node_modules/mysql2/promise');

function uuidv4() { return crypto.randomUUID(); }

const DINGTALK_KEY = process.env.DINGTALK_CLIENT_ID || 'dingdd7mcvqcyjsi7zfd';
const DINGTALK_SECRET = process.env.DINGTALK_CLIENT_SECRET || 'dScs9y1PNhI98OUP-SUHIoxzPt_krroIzLOuJD0aRO8de40Ue4i762stw19RfBn3';

// 钉钉部门树（手动定义，与实际组织架构一致）
const DINGTALK_DEPTS = [
  { id: 1,          name: '山东油焖侠文化传播有限公司', parent: null },
  { id: 64303514,   name: '油焖侠总办',               parent: 1 },
  { id: 65211308,   name: '财务管理组',               parent: 64303514 },
  { id: 735581922,  name: '综合管理中心',             parent: 1 },
  { id: 923610102,  name: '窜天猴中心',               parent: 1 },
  { id: 1033333599, name: '窜天猴中心代充组',         parent: 923610102 },
  { id: 1033519462, name: '窜天猴中心技术支持组',     parent: 923610102 },
  { id: 1033715187, name: '窜天猴中心直充组',         parent: 923610102 },
  { id: 1033425553, name: '豹量中心',                 parent: 1 },
  { id: 560515608,  name: '金币组',                   parent: 1033425553 },
  { id: 995771673,  name: '腾讯组',                   parent: 1033425553 },
  { id: 1056667052, name: 'TT项目',                   parent: 1 },
  { id: 1065773624, name: '美区',                     parent: 1056667052 },
  { id: 1066074672, name: '东南亚',                   parent: 1056667052 },
];

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getDingtalkToken() {
  const body = JSON.stringify({ appKey: DINGTALK_KEY, appSecret: DINGTALK_SECRET });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.dingtalk.com', path: '/v1.0/oauth2/accessToken',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { const p = JSON.parse(d); resolve(p.accessToken); });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function fetchDeptUsers(token, deptId) {
  const res = await httpsGet('oapi.dingtalk.com',
    `/user/listbypage?access_token=${token}&department_id=${deptId}&offset=0&size=100`);
  return res.userlist || [];
}

async function main() {
  console.log('=== 钉钉组织架构同步脚本 ===');
  console.log('拉取钉钉 access token...');
  const token = await getDingtalkToken();
  console.log('Token OK');

  // 拉取所有部门的用户，取 primaryDept（首个出现的部门即为主部门）
  console.log('拉取钉钉全员数据...');
  const userMap = {}; // userId -> { name, primaryDeptId }
  for (const dept of DINGTALK_DEPTS) {
    if (dept.id === 1) continue; // 跳过根节点
    const users = await fetchDeptUsers(token, dept.id);
    for (const u of users) {
      if (!userMap[u.userid]) {
        userMap[u.userid] = {
          userid: u.userid,
          name: u.name,
          primaryDeptId: dept.id,
          mobile: u.mobile || '',
          email: u.email || '',
          title: u.title || '',
        };
      }
    }
  }
  const dingtalkUsers = Object.values(userMap);
  console.log(`钉钉在职人员: ${dingtalkUsers.length} 人`);

  // 连接 MySQL
  const conn = await mysql2.createConnection({
    host: '127.0.0.1', port: 3306, user: 'root',
    password: 'RangerAI2026!', database: 'rangerai'
  });
  console.log('MySQL 连接 OK');

  // ── 1. 重建 departments 表 ──
  console.log('\n── 更新部门表 ──');
  // 获取现有部门
  const [existingDepts] = await conn.execute('SELECT id, name FROM departments');
  console.log(`现有部门: ${existingDepts.length} 条`);

  // 删除测试部门（不属于钉钉实际组织架构的）
  const validDeptNames = new Set(DINGTALK_DEPTS.map(d => d.name));
  let deletedDepts = 0;
  for (const d of existingDepts) {
    if (!validDeptNames.has(d.name)) {
      await conn.execute('DELETE FROM departments WHERE id=?', [d.id]);
      console.log(`  删除测试部门: ${d.name}`);
      deletedDepts++;
    }
  }

  // 刷新部门列表
  const [refreshedDepts] = await conn.execute('SELECT id, name FROM departments');
  const deptNameToId = {};
  for (const d of refreshedDepts) {
    deptNameToId[d.name] = d.id;
  }

  // 插入缺少的部门
  const dingIdToDbId = {};
  for (const dept of DINGTALK_DEPTS) {
    if (dept.id === 1) continue; // 不插入根节点
    if (!deptNameToId[dept.name]) {
      const newId = uuidv4();
      await conn.execute(
        'INSERT INTO departments (id, name, description, parent_id, sort_order, createdAt) VALUES (?,?,?,?,?,NOW())',
        [newId, dept.name, '', null, dept.id]
      );
      deptNameToId[dept.name] = newId;
      console.log(`  新增部门: ${dept.name} → ${newId}`);
    }
    dingIdToDbId[dept.id] = deptNameToId[dept.name];
  }

  // 更新 parent_id（需要先建好所有部门再更新父子关系）
  for (const dept of DINGTALK_DEPTS) {
    if (dept.id === 1 || !dept.parent || dept.parent === 1) continue;
    const dbId = dingIdToDbId[dept.id];
    const parentDbId = dingIdToDbId[dept.parent];
    if (dbId && parentDbId) {
      await conn.execute('UPDATE departments SET parent_id=? WHERE id=?', [parentDbId, dbId]);
    }
  }
  console.log(`部门同步完成，共 ${Object.keys(deptNameToId).length} 个部门`);

  // ── 2. 处理 users 表 ──
  console.log('\n── 更新用户表 ──');
  const [existingUsers] = await conn.execute('SELECT id, username, displayName, isActive FROM users');
  console.log(`现有用户: ${existingUsers.length} 条`);

  // 识别需要保留的系统用户（非员工账号）
  const SYSTEM_USERS = new Set(['jianwufy', 'acp-bridge', 'auditor', 'smoke_test', 'smoke-test-user']);

  // 钉钉员工姓名集合
  const dingtalkNameSet = new Set(dingtalkUsers.map(u => u.name));

  // 停用不在钉钉中且非系统用户的账号
  let deactivated = 0;
  for (const u of existingUsers) {
    if (SYSTEM_USERS.has(u.username)) continue;
    if (!dingtalkNameSet.has(u.displayName) && u.isActive) {
      await conn.execute('UPDATE users SET isActive=0 WHERE id=?', [u.id]);
      console.log(`  停用: ${u.displayName} (${u.username})`);
      deactivated++;
    }
  }
  console.log(`  已停用 ${deactivated} 个不在职人员`);

  // 为每个钉钉员工更新/写入 department_id（若已有 Ranger 账号）
  let updated = 0;
  let created = 0;
  for (const du of dingtalkUsers) {
    const deptDbId = dingIdToDbId[du.primaryDeptId];
    const match = existingUsers.find(u => u.displayName === du.name);
    if (match) {
      // 已有账号 → 更新部门 + 激活
      await conn.execute('UPDATE users SET department_id=?, isActive=1 WHERE id=?', [deptDbId || match.department_id, match.id]);
      updated++;
    } else {
      // 新员工 → 创建只读档案（无密码，role=member，isActive=1）
      const newId = uuidv4();
      const username = 'dt_' + du.userid; // 钉钉 userid 作为 username 前缀
      await conn.execute(
        `INSERT INTO users (id, username, passwordHash, salt, displayName, role, isActive, department_id, phone, email, createdAt)
         VALUES (?, ?, '', '', ?, 'member', 1, ?, ?, ?, NOW())`,
        [newId, username, du.name, deptDbId || null, du.mobile || null, du.email || null]
      );
      created++;
    }
  }
  console.log(`  已更新 ${updated} 个用户的部门归属`);
  console.log(`  新创建 ${created} 个员工档案`);

  // ── 3. 汇总输出 ──
  const [finalUsers] = await conn.execute('SELECT displayName, isActive, department_id FROM users WHERE username NOT IN (?) ORDER BY displayName', [Array.from(SYSTEM_USERS).join(',')]);
  console.log('\n── 同步结果汇总 ──');
  console.log(`钉钉在职: ${dingtalkUsers.length} 人`);
  console.log(`数据库活跃用户（非系统）: ${finalUsers.filter(u => u.isActive).length} 人`);
  console.log(`停用用户: ${finalUsers.filter(u => !u.isActive).length} 人`);

  await conn.end();
  console.log('\n✅ 同步完成');
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});

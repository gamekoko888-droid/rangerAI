/**
 * sync-dingtalk-sqlite.mjs
 * 从钉钉拉取最新组织架构，同步到 RangerAI SQLite 主库
 * 运行：node /opt/rangerai-agent/scripts/sync-dingtalk-sqlite.mjs
 * 
 * 策略：
 * 1. 保留现有系统用户和测试账号不动
 * 2. 对比钉钉数据 vs SQLite 现有员工（displayName 匹配）
 * 3. 在职但未在 SQLite 的 → 不批量创建（无登录账号），只更新有账号的
 * 4. 更新 u001~uXXX 格式用户的部门归属（与钉钉姓名匹配）
 * 5. 钉钉已离职但在 SQLite 的 → isActive=0（系统用户除外）
 * 6. 输出对比报告
 */

import https from 'https';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('/opt/rangerai-agent/node_modules/better-sqlite3');

const DINGTALK_KEY = process.env.DINGTALK_CLIENT_ID || 'dingdd7mcvqcyjsi7zfd';
const DINGTALK_SECRET = process.env.DINGTALK_CLIENT_SECRET || 'dScs9y1PNhI98OUP-SUHIoxzPt_krroIzLOuJD0aRO8de40Ue4i762stw19RfBn3';
const DB_PATH = '/opt/rangerai-agent/rangerai.db';

// 系统账号，永远不停用
const SYSTEM_USERNAMES = new Set([
  'jianwufy', 'acp-bridge', 'auditor', 'smoke_test', 'smoke-test-user',
  'jianwufy1', 'HanamiRin', 'VogtTomato', 'david', 'hungryleon',
  'jggaoyong@gmail.com', 'guest_april', 'ranger_new', 'newuser',
  'ranger_user2026', 'ranger_demo', 'ranger_guest', 'test_ranger_admin_2207',
  'test_cs_user', 'test_manager', 'ba3ac19f', 'smoke-test-user', '伯虎'
]);

// 钉钉部门树 → SQLite departments 表名 映射
const DINGTALK_DEPT_TO_SQLITE = {
  64303514:   '综合管理中心',   // 油焖侠总办 → 综合管理中心（财务+行政混入）
  65211308:   '综合管理中心',   // 财务管理组
  735581922:  '综合管理中心',   // 综合管理中心
  923610102:  '窜天猴中心',
  1033333599: '代充+云机+备货组',
  1033519462: '技术组',
  1033715187: '直充组',
  1033425553: '豹量中心',
  560515608:  '金币组',
  995771673:  '腾讯组',
  1056667052: 'TT项目组',
  1065773624: '美区',
  1066074672: '东南亚区',
};

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
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oapi.dingtalk.com',
      path: `/user/listbypage?access_token=${token}&department_id=${deptId}&offset=0&size=100`,
      method: 'GET'
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).userlist || []); } catch { resolve([]); } });
    });
    req.on('error', reject);
    req.end();
  });
}

const DINGTALK_DEPTS_LIST = [
  64303514, 65211308, 735581922, 923610102,
  1033333599, 1033519462, 1033715187,
  1033425553, 560515608, 995771673,
  1056667052, 1065773624, 1066074672
];

async function main() {
  console.log('=== 钉钉 → SQLite 组织同步 ===');
  
  // 1. 拉取钉钉数据
  console.log('拉取钉钉 token...');
  const token = await getDingtalkToken();
  
  console.log('拉取全员数据...');
  const userMap = {};
  for (const deptId of DINGTALK_DEPTS_LIST) {
    const users = await fetchDeptUsers(token, deptId);
    for (const u of users) {
      if (!userMap[u.userid]) {
        userMap[u.userid] = {
          userid: u.userid,
          name: u.name,
          primaryDeptId: deptId,
        };
      }
    }
  }
  const dingtalkUsers = Object.values(userMap);
  const dingtalkNameSet = new Set(dingtalkUsers.map(u => u.name));
  console.log(`钉钉在职: ${dingtalkUsers.length} 人`);

  // 2. 连接 SQLite
  const db = new Database(DB_PATH);
  
  // 获取部门名→id 映射
  const depts = db.prepare('SELECT id, name FROM departments').all();
  const deptNameToId = {};
  for (const d of depts) deptNameToId[d.name] = d.id;
  console.log(`SQLite 部门: ${depts.length} 个`);
  
  // 获取所有非系统用户
  const allUsers = db.prepare('SELECT id, username, displayName, isActive, department_id FROM users').all();
  const employeeUsers = allUsers.filter(u => !SYSTEM_USERNAMES.has(u.username) && !SYSTEM_USERNAMES.has(u.displayName));
  console.log(`SQLite 员工账号（非系统）: ${employeeUsers.length} 条`);

  // 3. 停用不在钉钉的员工
  let deactivated = 0;
  const updateActive = db.prepare('UPDATE users SET isActive=0 WHERE id=?');
  for (const u of employeeUsers) {
    if (!dingtalkNameSet.has(u.displayName) && u.isActive) {
      updateActive.run(u.id);
      console.log(`  [停用] ${u.displayName} (${u.username}) — 不在钉钉在职名单`);
      deactivated++;
    }
  }

  // 4. 更新有账号的钉钉员工的部门归属
  let updated = 0;
  const updateDept = db.prepare('UPDATE users SET department_id=?, isActive=1 WHERE id=?');
  for (const du of dingtalkUsers) {
    const sqliteDeptName = DINGTALK_DEPT_TO_SQLITE[du.primaryDeptId];
    const sqliteDeptId = sqliteDeptName ? deptNameToId[sqliteDeptName] : null;
    const match = employeeUsers.find(u => u.displayName === du.name);
    if (match && sqliteDeptId) {
      updateDept.run(sqliteDeptId, match.id);
      updated++;
    }
  }

  // 5. 找出在钉钉但在 SQLite 没有账号的人
  const sqliteNameSet = new Set(employeeUsers.map(u => u.displayName));
  const missingInSqlite = dingtalkUsers.filter(du => !sqliteNameSet.has(du.name));

  // 6. 汇总
  const [finalActive] = [db.prepare('SELECT COUNT(*) as n FROM users WHERE isActive=1').get()];
  
  console.log('\n── 同步结果 ──');
  console.log(`已停用不在职员工: ${deactivated} 人`);
  console.log(`已更新部门归属: ${updated} 人`);
  console.log(`SQLite 当前活跃用户: ${finalActive.n} 人`);
  
  if (missingInSqlite.length > 0) {
    console.log(`\n[注意] 以下 ${missingInSqlite.length} 位在职员工在 SQLite 中没有账号（仅展示，未自动创建）:`);
    for (const u of missingInSqlite) {
      const deptName = DINGTALK_DEPT_TO_SQLITE[u.primaryDeptId] || `钉钉部门${u.primaryDeptId}`;
      console.log(`  ${u.name} | ${deptName}`);
    }
    console.log('\n如需创建这些账号，运行: node scripts/sync-dingtalk-sqlite.mjs --create-missing');
  }

  // 如果加了 --create-missing 参数，批量创建缺失账号
  if (process.argv.includes('--create-missing')) {
    console.log('\n── 创建缺失员工档案 ──');
    const insertUser = db.prepare(`
      INSERT OR IGNORE INTO users (id, username, passwordHash, salt, displayName, role, isActive, department_id, createdAt)
      VALUES (?, ?, '', '', ?, 'member', 1, ?, datetime('now'))
    `);
    let created = 0;
    for (const du of missingInSqlite) {
      const id = 'dt_' + du.userid;
      const username = 'dt_' + du.userid;
      const sqliteDeptName = DINGTALK_DEPT_TO_SQLITE[du.primaryDeptId];
      const sqliteDeptId = sqliteDeptName ? deptNameToId[sqliteDeptName] : null;
      insertUser.run(id, username, du.name, sqliteDeptId);
      created++;
    }
    console.log(`  新建 ${created} 个员工档案（无密码，role=member）`);
  }

  db.close();
  console.log('\n✅ 完成');
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});

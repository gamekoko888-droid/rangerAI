import { initAdapter, query, run } from './db-adapter.mjs';

async function buildOrgStructure() {
    try {
        await initAdapter();
        console.log('Building department hierarchy...');

        // 1. 定义核心中心 (Center)
        const centers = [
            { name: "综合管理中心", desc: "公司行政、财务、人事核心" },
            { name: "豹量中心", desc: "腾讯业务与金币业务核心" },
            { name: "TT项目组", desc: "TikTok 全球业务项目组" },
            { name: "窜天猴中心", desc: "技术开发、代充、云机与直充业务" }
        ];

        const centerMap = {};

        for (const c of centers) {
            let dept = await query('SELECT id FROM departments WHERE name = ?', [c.name]);
            let deptId;
            if (dept.length === 0) {
                deptId = `dept_${Math.random().toString(36).substr(2, 6)}`;
                await run('INSERT INTO departments (id, name, description, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)', 
                    [deptId, c.name, c.desc, null, 0]);
            } else {
                deptId = dept[0].id;
            }
            centerMap[c.name] = deptId;
        }

        // 2. 建立二级小组 (Groups) 并关联人员
        const subGroups = {
            "豹量中心": ["腾讯组", "金币组"],
            "TT项目组": ["东南亚区", "美区"],
            "窜天猴中心": ["技术组", "代充+云机+备货组", "直充组"]
        };

        const groupMap = {};

        for (const [parentName, groups] of Object.entries(subGroups)) {
            const parentId = centerMap[parentName];
            for (const gName of groups) {
                const fullName = `${parentName}${gName}`;
                let g = await query('SELECT id FROM departments WHERE name = ?', [gName]);
                let gId;
                if (g.length === 0) {
                    gId = `g_${Math.random().toString(36).substr(2, 6)}`;
                    await run('INSERT INTO departments (id, name, parent_id, sort_order) VALUES (?, ?, ?, ?)', 
                        [gId, gName, parentId, 1]);
                } else {
                    gId = g[0].id;
                }
                groupMap[fullName] = gId;
            }
        }

        // 3. 将现有的 97 人关联到对应的三级/二级 ID
        const users = await query('SELECT id, displayName, team, department_id FROM users');
        for (const u of users) {
             let targetDeptId = centerMap[u.department_id] || u.department_id;
             
             // 尝试匹配小组
             for (const [fullName, gId] of Object.entries(groupMap)) {
                 if (u.team && u.team.includes(fullName.replace(u.department_id, ''))) {
                     targetDeptId = gId;
                     break;
                 }
                 // 模糊匹配：如果 team 包含 "腾讯组" 且 department_id 是 "豹量中心"
                 if (u.team && u.team.includes("腾讯组") && u.department_id === "豹量中心") targetDeptId = groupMap["豹量中心腾讯组"];
                 if (u.team && u.team.includes("金币组") && u.department_id === "豹量中心") targetDeptId = groupMap["豹量中心金币组"];
                 if (u.team && u.team.includes("技术组") && u.department_id === "窜天猴中心") targetDeptId = groupMap["窜天猴中心技术组"];
                 if (u.team && u.team.includes("直充组") && u.department_id === "窜天猴中心") targetDeptId = groupMap["窜天猴中心直充组"];
                 if (u.team && u.team.includes("东南亚") && u.department_id === "TT项目组") targetDeptId = groupMap["TT项目组东南亚区"];
                 if (u.team && u.team.includes("美区") && u.department_id === "TT项目组") targetDeptId = groupMap["TT项目组美区"];
             }

             await run('UPDATE users SET department_id = ? WHERE id = ?', [targetDeptId, u.id]);
        }

        console.log('Hierarchy build completed.');
    } catch (err) {
        console.error('Build failed:', err);
    } finally {
        process.exit(0);
    }
}

buildOrgStructure();

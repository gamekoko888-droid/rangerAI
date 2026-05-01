import { initAdapter, query, run } from './db-adapter.mjs';
import crypto from 'crypto';

const staffData = [
    {id: 1, name: "赵永贵", dept: "综合管理中心", role: "负责人"},
    {id: 2, name: "陈国梅", dept: "综合管理中心", role: "心要野/行归/蔚来上云 直充业务 财务"},
    {id: 3, name: "李然", dept: "综合管理中心", role: "库管审查"},
    {id: 4, name: "马洁", dept: "综合管理中心", role: "豹量/鲸跃 代充 财务"},
    {id: 5, name: "孟美佳", dept: "综合管理中心", role: "人事"},
    {id: 6, name: "朱红", dept: "综合管理中心", role: "行政"},
    {id: 7, name: "李玉萍", dept: "综合管理中心", role: "人事"},
    {id: 8, name: "陈子伟", dept: "综合管理中心", role: "总裁助理"},
    {id: 9, name: "刘臣洁", dept: "综合管理中心", role: "油焖侠/三生万物 腾讯业务 财务"},
    {id: 10, name: "闫会林", dept: "综合管理中心", role: "后勤保障"},
    {id: 11, name: "徐庆", dept: "豹量中心", role: "负责人"},
    {id: 12, name: "王世冠", dept: "豹量中心/TT项目组", role: "腾讯组组长+TT项目东南亚区组长"},
    {id: 13, name: "金兴路", dept: "豹量中心腾讯组", role: "腾讯组-游戏客服小组长"},
    {id: 14, name: "许洛雨", dept: "豹量中心腾讯组", role: "腾讯组-游戏客服小组长"},
    {id: 15, name: "王业佳", dept: "豹量中心腾讯组", role: "腾讯组-游戏客服小组长"},
    {id: 16, name: "李翔", dept: "豹量中心腾讯组", role: "腾讯组-游戏客服小组长"},
    {id: 17, name: "路熙锾", dept: "豹量中心腾讯组", role: "腾讯组-游戏客服"},
    {id: 18, name: "楊寶萱", dept: "豹量中心腾讯组", role: "腾讯组-游戏客服"},
    {id: 19, name: "张昊天", dept: "豹量中心腾讯组", role: "腾讯组-游戏客服"},
    {id: 20, name: "贾炜", dept: "豹量中心腾讯组", role: "腾讯组-商务"},
    {id: 21, name: "刘金青", dept: "豹量中心金币组", role: "金币组组长"},
    {id: 22, name: "宋修壮", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 23, name: "张子怡", dept: "豹量中心金币组", role: "金币组-游戏客服小组长"},
    {id: 24, name: "张帆", dept: "豹量中心金币组", role: "金币组-游戏客服小组长"},
    {id: 25, name: "陈冲", dept: "豹量中心金币组", role: "金币组-游戏客服（收金）"},
    {id: 26, name: "吕帅", dept: "豹量中心金币组", role: "金币组-游戏客服小组长"},
    {id: 27, name: "赵龙", dept: "豹量中心金币组", role: "金币组-游戏客服小组长"},
    {id: 28, name: "张磊", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 29, name: "魏铭宇", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 30, name: "刘东悦", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 31, name: "姜鹏程", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 32, name: "崔浩伟", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 33, name: "王新儀", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 34, name: "王子琪", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 35, name: "李中强", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 36, name: "侯照硕", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 37, name: "孙佳琪", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 38, name: "陈成龙", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 39, name: "王洋", dept: "豹量中心金币组", role: "金币组-游戏客服"},
    {id: 40, name: "张弘", dept: "豹量中心金币组", role: "金币组-产金组长"},
    {id: 41, name: "盖健琳", dept: "豹量中心金币组", role: "金币组-产金专员"},
    {id: 42, name: "吕晨曦", dept: "TT项目组东南亚区", role: "新加坡、马来组长"},
    {id: 43, name: "郭昊森", dept: "TT项目组东南亚区", role: "KOL商务-印尼组长"},
    {id: 44, name: "刘书奇", dept: "TT项目组东南亚区", role: "KOL商务-菲律宾"},
    {id: 45, name: "李业川", dept: "TT项目组东南亚区", role: "KOL商务-新马"},
    {id: 46, name: "孙欣怡", dept: "TT项目组东南亚区", role: "剪辑"},
    {id: 47, name: "尹金玉", dept: "TT项目组东南亚区", role: "剪辑"},
    {id: 48, name: "赵菲", dept: "TT项目组东南亚区", role: "剪辑"},
    {id: 49, name: "刘东福", dept: "TT项目组东南亚区", role: "运营"},
    {id: 50, name: "郑家乐", dept: "TT项目组东南亚区", role: "运营"},
    {id: 51, name: "路晓倩", dept: "TT项目组美区", role: "运营"},
    {id: 52, name: "师菲飞", dept: "TT项目组美区", role: "运营"},
    {id: 53, name: "杜心雨", dept: "TT项目组美区", role: "剪辑"},
    {id: 54, name: "高明圣", dept: "TT项目组美区", role: "运营"},
    {id: 55, name: "姜高勇", dept: "窜天猴中心技术组", role: "前端java"},
    {id: 56, name: "王虎寅", dept: "窜天猴中心技术组", role: "后端java"},
    {id: 57, name: "于志强", dept: "窜天猴中心技术组", role: "后端java"},
    {id: 58, name: "侯斌", dept: "窜天猴中心", role: "负责人"},
    {id: 59, name: "许皓然", dept: "窜天猴中心", role: "总监助理"},
    {id: 60, name: "李增龙", dept: "窜天猴中心代充+云机+备货组", role: "代充-云机-备货-负责人"},
    {id: 61, name: "杜博宇", dept: "窜天猴中心代充+云机+备货组", role: "代充-012负责人"},
    {id: 62, name: "杨锐", dept: "窜天猴中心代充+云机+备货组", role: "代充小组长"},
    {id: 63, name: "宋骅韬", dept: "窜天猴中心代充+云机+备货组", role: "备货组-游戏客服"},
    {id: 64, name: "邸士尧", dept: "窜天猴中心代充+云机+备货组", role: "备货组-游戏客服"},
    {id: 65, name: "郁志凯", dept: "窜天猴中心代充+云机+备货组", role: "云机组-游戏客服"},
    {id: 66, name: "胡利伟", dept: "窜天猴中心代充+云机+备货组", role: "云机组-游戏客服"},
    {id: 67, name: "宋政良", dept: "窜天猴中心代充+云机+备货组", role: "云机组-游戏客服"},
    {id: 68, name: "王志鹏", dept: "窜天猴中心代充+云机+备货组", role: "云机组-游戏客服"},
    {id: 69, name: "刘圣龙", dept: "窜天猴中心代充+云机+备货组", role: "云机组-游戏客服"},
    {id: 70, name: "杨贺", dept: "窜天猴中心代充+云机+备货组", role: "云机组-游戏客服"},
    {id: 71, name: "杜潇天宇", dept: "窜天猴中心代充+云机+备货组", role: "云机组-游戏客服"},
    {id: 72, name: "刘杰", dept: "窜天猴中心代充+云机+备货组", role: "云机组-游戏客服"},
    {id: 73, name: "李兰兰", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 74, name: "李富康", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 75, name: "王硕", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 76, name: "徐艺伟", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 77, name: "冯振旺", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 78, name: "杨晨", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 79, name: "王淑蕾", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 80, name: "王浩", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 81, name: "王德康", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 82, name: "郭祥祥", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 83, name: "刘滋晨", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 84, name: "王柯嵩", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 85, name: "吴子豪", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 86, name: "李青梅", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 87, name: "梁淼", dept: "窜天猴中心代充+云机+备货组", role: "代充组-游戏客服"},
    {id: 88, name: "苏悦", dept: "窜天猴中心直充组", role: "窜天猴中心-直充组负责人"},
    {id: 89, name: "刘辉", dept: "窜天猴中心直充组", role: "窜天猴中心-直充小组长"},
    {id: 90, name: "耿立芹", dept: "窜天猴中心直充组", role: "直充组-游戏客服"},
    {id: 91, name: "宋可鑫", dept: "窜天猴中心直充组", role: "直充组-游戏客服"},
    {id: 92, name: "荆茂祥", dept: "窜天猴中心直充组", role: "直充组-游戏客服"},
    {id: 93, name: "宗培龙", dept: "窜天猴中心直充组", role: "直充组-游戏客服"},
    {id: 94, name: "路士卓", dept: "窜天猴中心直充组", role: "直充组-游戏客服"},
    {id: 95, name: "刘子杰", dept: "窜天猴中心直充组", role: "直充组-游戏客服"},
    {id: 96, name: "宗钊", dept: "窜天猴中心直充组", role: "直充组-游戏客服"},
    {id: 97, name: "赵昱斌", dept: "窜天猴中心直充组", role: "直充组-游戏客服"}
];

async function importStaff() {
    try {
        await initAdapter();
        console.log('Adapter initialized. Starting import...');

        for (const person of staffData) {
            // Check if user exists by displayName
            const existing = await query('SELECT id FROM users WHERE displayName = ?', [person.name]);
            
            if (existing && existing.length > 0) {
                // Update existing
                await run('UPDATE users SET team = ?, department_id = ? WHERE displayName = ?', 
                    [person.role, person.dept, person.name]);
                console.log(`Updated: ${person.name}`);
            } else {
                // Create new
                const id = `u${person.id.toString().padStart(3, '0')}`;
                const salt = crypto.randomBytes(16).toString('hex');
                const passwordHash = crypto.createHash('sha256').update('password123' + salt).digest('hex');
                
                await run(`INSERT INTO users (id, username, passwordHash, salt, displayName, role, team, department_id, isActive) 
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [id, `user_${person.id}`, passwordHash, salt, person.name, 'member', person.role, person.dept, 1]);
                console.log(`Created: ${person.name}`);
            }
        }

        console.log('Import completed successfully.');
    } catch (err) {
        console.error('Import failed:', err);
    } finally {
        process.exit(0);
    }
}

importStaff();

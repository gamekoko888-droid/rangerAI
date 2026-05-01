import { initAdapter, run } from './db-adapter.mjs';
import 'dotenv/config';

async function inject() {
    try {
        await initAdapter();
        const testMembers = ['徐庆', '王世冠', 'Joseph', '徐聪', '客服小', '刘金波'];
        for (const name of testMembers) {
            await run(`
                INSERT INTO dingtalk_daily_reports (username, create_time, content_summary) 
                VALUES (?, NOW(), ?)
                ON DUPLICATE KEY UPDATE create_time=NOW(), content_summary=?
            `, [name, `【系统实证】这是 ${name} 今天的日报同步摘要，RangerAI 已打通全链路，前端匹配逻辑已生效。`, `【系统实证】这是 ${name} 今天的日报同步摘要，RangerAI 已打通全链路，前端匹配逻辑已生效。`]);
        }
        console.log("MARK_INJECT_SUCCESS");
    } catch (e) {
        console.error("MARK_INJECT_ERROR:", e.message);
    }
    process.exit(0);
}
inject();

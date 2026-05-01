import { query, initAdapter } from "./db-adapter.mjs";
import { loadEnvFile } from "./lib/bootstrap.mjs";

loadEnvFile("/opt/rangerai-agent/.env");

async function run() {
    try {
        await initAdapter();
        console.log(`Deep searching for reports around 2026-03-15...`);
        
        // 扩大范围：昨天至今的所有记录
        const reports = await query(`
            SELECT id, creator_name, dept_name, template_name, report_date, create_time 
            FROM dingtalk_reports 
            WHERE create_time >= '2026-03-14 00:00:00' 
            ORDER BY create_time DESC
        `);
        
        console.log(`---ALL_RECENT_REPORTS_START---`);
        console.log(JSON.stringify(reports));
        console.log(`---ALL_RECENT_REPORTS_END---`);
        
    } catch (e) {
        console.log("ERROR: " + e.message);
    }
}

run();

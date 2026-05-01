import { query, initAdapter } from "./db-adapter.mjs";
import { loadEnvFile } from "./lib/bootstrap.mjs";

loadEnvFile("/opt/rangerai-agent/.env");

async function run() {
    try {
        await initAdapter();
        const today = new Date().toISOString().split('T')[0];
        console.log(`Analyzing reports for ${today}...`);
        
        // 1. 获取今日日报列表
        const reports = await query(`
            SELECT * FROM dingtalk_reports 
            WHERE create_time LIKE ? OR report_date = ? 
            ORDER BY create_time ASC
        `, [`${today}%`, today]);
        
        if (!reports || reports.length === 0) {
            console.log("NO_REPORTS_FOUND");
            return;
        }
        
        console.log(`Found ${reports.length} reports.`);
        console.log("---DATA_START---");
        console.log(JSON.stringify(reports));
        console.log("---DATA_END---");
        
    } catch (e) {
        console.log("ERROR: " + e.message);
    }
}

run();

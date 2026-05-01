
import { initAdapter, query, run } from './db-adapter.mjs';

async function syncOrgFinal() {
    try {
        await initAdapter();
        console.log('Finalizing 97-staff Organizational Brain...');

        // 1. 完善 97 人的日报状态字段 (增加 metadata 容纳钉钉 ID 和 日报时间)
        // 这一步是为了让前端呼吸灯有数据可读
        await run(`UPDATE users SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.pulse', 'active') WHERE isActive = 1`);
        
        // 2. 将王世冠设置为跨组长 (Cross-team mapping)
        await run(`UPDATE users SET team = '豹量中心+TT项目组 联合组长' WHERE displayName = '王世冠'`);

        console.log('Operational metadata synchronized.');
    } catch (err) {
        console.error('Sync failed:', err);
    } finally {
        process.exit(0);
    }
}

syncOrgFinal();

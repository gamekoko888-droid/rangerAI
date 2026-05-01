import { initAdapter, run } from '../db-adapter.mjs';
async function migrate() {
    try {
        console.log('--- Database Migration [tiktok_partners] ---');
        const adapter = await initAdapter();
        
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS tiktok_partners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kol_handle TEXT NOT NULL,
                country TEXT NOT NULL,
                game_category TEXT,
                sharing_ratio REAL DEFAULT 0.00,
                base_fee REAL DEFAULT 0.00,
                milestone_stage TEXT DEFAULT 'contacted' CHECK(milestone_stage IN ('contacted','negotiating','agreed','onboarding','active')),
                store_url TEXT,
                bank_info TEXT,
                last_update TEXT DEFAULT (datetime('now'))
            );
        `;
        
        await run(createTableSql);
        await run(`CREATE INDEX IF NOT EXISTS idx_tp_kol ON tiktok_partners(kol_handle);`);
        await run(`CREATE INDEX IF NOT EXISTS idx_tp_country ON tiktok_partners(country);`);
        console.log('✅ Table [tiktok_partners] created successfully.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}
migrate();

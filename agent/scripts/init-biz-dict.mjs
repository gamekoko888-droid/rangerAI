import { initAdapter, query, run } from './db-adapter.mjs';

async function setupDingTalkDictionary() {
    try {
        await initAdapter();
        console.log('Injecting 97-staff business dictionary into database...');

        // 1. 创建业务关键字映射表
        const bizMapping = [
            { name: "陈国梅", keywords: "直充, 财务, 心要野, 行归" },
            { name: "马洁", keywords: "代充, 财务, 豹量, 鲸跃" },
            { name: "王世冠", keywords: "TT, 东南亚, 腾讯组, 组长" },
            { name: "刘金青", keywords: "金币, 客服, 组长" },
            { name: "张弘", keywords: "产金, 组长" },
            { name: "吕晨曦", keywords: "TT, 新马, 组长" },
            { name: "郭昊森", keywords: "KOL, 印尼, 商务" },
            { name: "姜高勇", keywords: "技术, java, 前端" },
            { name: "侯斌", keywords: "窜天猴, 负责人" },
            { name: "李增龙", keywords: "代充, 云机, 备货, 负责人" },
            { name: "苏悦", keywords: "直充, 负责人" }
        ];

        for (const biz of bizMapping) {
            await run('UPDATE users SET tags = ? WHERE displayName = ?', [biz.keywords, biz.name]);
        }

        console.log('Business metadata injected.');
    } catch (err) {
        console.error('Injection failed:', err);
    } finally {
        process.exit(0);
    }
}

setupDingTalkDictionary();

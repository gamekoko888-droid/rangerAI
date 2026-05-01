// Test cases for smart-router v3 classification accuracy
import { smartRoute } from './worker/smart-router.mjs';

const testCases = [
  // code
  { input: "帮我写一个Python爬虫脚本", expected: "code", desc: "Python脚本" },
  { input: "这个bug怎么修", expected: "code", desc: "修bug" },
  { input: "帮我debug这段代码", expected: "code", desc: "debug" },
  { input: "写一个React组件", expected: "code", desc: "React组件" },
  { input: "```js\nconst x = 1;\n```\n这段代码有什么问题", expected: "code", desc: "代码块" },
  
  // reasoning
  { input: "帮我分析一下这个商业模式的优缺点，对比三种方案的利弊", expected: "reasoning", desc: "对比分析" },
  { input: "这个架构设计有什么问题？帮我评估一下性能瓶颈", expected: "reasoning", desc: "架构评估" },
  
  // sysadmin
  { input: "帮我部署到阿里云服务器", expected: "sysadmin", desc: "部署" },
  { input: "nginx配置有问题，502了", expected: "sysadmin", desc: "nginx" },
  { input: "服务器磁盘满了怎么清理", expected: "sysadmin", desc: "磁盘清理" },
  
  // chinese_content
  { input: "帮我写一篇小红书爆款文案", expected: "chinese_content", desc: "小红书文案" },
  { input: "润色一下这篇文章，语气要专业", expected: "chinese_content", desc: "润色文章" },
  
  // research
  { input: "帮我调研东南亚游戏充值市场", expected: "research", desc: "市场调研" },
  { input: "帮我搜一下最新的KOL投放数据", expected: "research", desc: "KOL数据" },
  
  // creative
  { input: "帮我写一个品牌故事", expected: "creative", desc: "品牌故事" },
  
  // translation
  { input: "翻译成英文", expected: "translation", desc: "翻译" },
  { input: "帮我把这段话翻译成日语", expected: "translation", desc: "日语翻译" },
  
  // gaming
  { input: "云顶之弈最强阵容推荐", expected: "gaming", desc: "云顶阵容" },
  { input: "原神角色怎么搭配", expected: "gaming", desc: "原神搭配" },
  
  // chat (should NOT be misclassified)
  { input: "你好", expected: "chat", desc: "问好" },
  { input: "后端开发必须懂JAVA吗", expected: "chat", desc: "知识问答" },
  { input: "山姆有哪些低热量又好吃的零食", expected: "chat", desc: "生活问答" },
  { input: "React和Vue哪个好", expected: "chat", desc: "技术对比问答" },
  { input: "你的前端输出为什么这么不稳定", expected: "chat", desc: "AI系统元问题" },
  
  // CRITICAL: These should NOT go to cheap models
  { input: "帮我分析一下这段代码的性能问题", expected: "code", desc: "代码性能分析(应该是code不是reasoning)" },
  { input: "分析一下服务器日志找出错误原因", expected: "sysadmin", desc: "日志分析(应该是sysadmin不是reasoning)" },
];

let passed = 0;
let failed = 0;
const failures = [];

for (const tc of testCases) {
  const result = smartRoute(tc.input);
  const ok = result.category === tc.expected;
  if (ok) {
    passed++;
    console.log(`  ✅ ${tc.desc}: "${tc.input.substring(0,30)}..." → ${result.category} (${result.model})`);
  } else {
    failed++;
    failures.push(tc);
    console.log(`  ❌ ${tc.desc}: "${tc.input.substring(0,30)}..." → ${result.category} (expected: ${tc.expected}) model=${result.model}`);
  }
}

console.log(`\n=== Results: ${passed}/${passed+failed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log('\nFailed cases:');
  for (const f of failures) {
    const r = smartRoute(f.input);
    console.log(`  ${f.desc}: got ${r.category} (conf=${r.confidence.toFixed(2)}), expected ${f.expected}`);
  }
}

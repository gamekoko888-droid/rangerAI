// Smart Router v2 — Task Classification Engine
const PATTERNS = {
  code: {
    keywords: /\b(code|debug|fix|error|bug|compile|syntax|function|class|variable|import|export)\b/i,
    cnKeywords: /(?:代码|编程|调试|修复|报错|错误|函数|变量|编译|语法)/,
    weight: 0.8
  },
  research: {
    keywords: /\b(search|find|look up|research|investigate|analyze|compare|review)\b/i,
    cnKeywords: /(?:搜索|查找|调研|分析|对比|研究|查看|了解|怎么办|如何)/,
    weight: 0.7
  },
  creative: {
    keywords: /\b(write|create|generate|design|compose|draft|brainstorm)\b/i,
    cnKeywords: /(?:写|创建|生成|设计|编写|起草|构思|输出|制作)/,
    weight: 0.6
  },
  chat: {
    keywords: /\b(hello|hi|hey|thanks|ok|sure|yes|no|good|great)\b/i,
    cnKeywords: /(?:你好|谢谢|好的|嗯|是的|不是|可以|明白)/,
    weight: 0.3
  },
  gaming: {
    keywords: /\b(game|gaming|esports|champion|hero|build|loadout|strategy)\b/i,
    cnKeywords: /(?:游戏|电竞|英雄|阵容|出装|攻略|副本|装备)/,
    weight: 0.5
  },
  sysadmin: {
    keywords: /\b(server|deploy|nginx|docker|systemctl|ssh|firewall|backup)\b/i,
    cnKeywords: /(?:服务器|部署|运维|配置|防火墙|备份|重启|监控)/,
    weight: 0.6
  }
};

function classifyTask(message) {
  const scores = {};
  for (const [category, pattern] of Object.entries(PATTERNS)) {
    let score = 0;
    if (pattern.keywords.test(message)) score += pattern.weight;
    if (pattern.cnKeywords.test(message)) score += pattern.weight * 0.8;
    scores[category] = score;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : "research";
}

export { PATTERNS, classifyTask };

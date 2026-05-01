import https from "https";
import { readFileSync } from "fs";

// Get Google API key
let apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  try {
    const cfg = JSON.parse(readFileSync("/home/admin/.openclaw/openclaw.json", "utf-8"));
    apiKey = cfg?.models?.providers?.google?.apiKey;
  } catch (e) {}
}
console.log("API key available:", !!apiKey, "length:", apiKey?.length);

const body = JSON.stringify({
  contents: [{ role: "user", parts: [{ text: "做一个长春旅游的介绍页面" }] }],
  systemInstruction: { parts: [{ text: `你是一个任务分类器。分析用户消息，判断任务类型。
可选类型：code, reasoning, sysadmin, chinese_content, research, creative, chat, translation, gaming, image_generation
- 如果涉及创建网页/页面/网站/前端 → code
- 如果涉及写代码/调试/部署 → code
- 如果涉及写文案/周报/公告 → chinese_content
- 如果涉及分析/对比/推理 → reasoning
- 短消息且无明确领域指向 → chat
只输出JSON：{"type":"类型","confidence":0.9}` }] },
  generationConfig: { maxOutputTokens: 200, temperature: 0.05, responseMimeType: "application/json" }
});

const req = https.request({
  hostname: "generativelanguage.googleapis.com",
  port: 443,
  path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
}, res => {
  let data = "";
  res.on("data", c => data += c);
  res.on("end", () => {
    console.log("Status:", res.statusCode);
    const parsed = JSON.parse(data);
    console.log("Full response:", JSON.stringify(parsed, null, 2).substring(0, 2000));
    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log("\nRaw text:", JSON.stringify(text));
    console.log("finishReason:", parsed.candidates?.[0]?.finishReason);
    console.log("usageMetadata:", JSON.stringify(parsed.usageMetadata));
    
    // Try to parse
    if (text) {
      const firstBrace = text.indexOf('{');
      console.log("firstBrace index:", firstBrace);
      if (firstBrace >= 0) {
        const jsonText = text.substring(firstBrace);
        console.log("jsonText:", jsonText);
        try {
          const result = JSON.parse(jsonText);
          console.log("Parsed result:", result);
        } catch (e) {
          console.log("Parse error:", e.message);
        }
      }
    }
    process.exit(0);
  });
});
req.write(body);
req.end();

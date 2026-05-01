#!/usr/bin/env node
/**
 * Test all three direct API providers: OpenAI, Anthropic, Google
 * Run on the server: node /opt/rangerai-agent/test-direct-apis.mjs
 */
import https from "https";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

function testOpenAI() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say 'OpenAI OK' in exactly 2 words." }],
      max_tokens: 20,
      stream: false
    });
    const req = https.request({
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || "";
          resolve({ ok: true, status: res.statusCode, content: content.trim(), model: parsed.model });
        } else {
          resolve({ ok: false, status: res.statusCode, error: data.substring(0, 200) });
        }
      });
    });
    req.on("error", err => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

function testAnthropic() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 20,
      messages: [{ role: "user", content: "Say 'Anthropic OK' in exactly 2 words." }]
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          const content = parsed.content?.[0]?.text || "";
          resolve({ ok: true, status: res.statusCode, content: content.trim(), model: parsed.model });
        } else {
          resolve({ ok: false, status: res.statusCode, error: data.substring(0, 200) });
        }
      });
    });
    req.on("error", err => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

function testGoogle() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Say 'Google OK' in exactly 2 words." }] }],
      generationConfig: { maxOutputTokens: 20 }
    });
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: `/v1beta/models/gemini-3-flash-preview:generateContent?key=${GOOGLE_API_KEY}`,
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
          resolve({ ok: true, status: res.statusCode, content: content.trim(), model: "gemini-2.5-flash" });
        } else {
          resolve({ ok: false, status: res.statusCode, error: data.substring(0, 200) });
        }
      });
    });
    req.on("error", err => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log("=== Testing Direct API Connections ===\n");
  
  console.log(`OPENAI_API_KEY: ${OPENAI_API_KEY ? `${OPENAI_API_KEY.substring(0, 12)}...` : "NOT SET"}`);
  console.log(`ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? `${ANTHROPIC_API_KEY.substring(0, 12)}...` : "NOT SET"}`);
  console.log(`GOOGLE_API_KEY: ${GOOGLE_API_KEY ? `${GOOGLE_API_KEY.substring(0, 12)}...` : "NOT SET"}`);
  console.log("");

  console.log("1. Testing OpenAI (gpt-4o-mini)...");
  const openai = await testOpenAI();
  console.log(`   ${openai.ok ? "✅" : "❌"} OpenAI: ${JSON.stringify(openai)}\n`);

  console.log("2. Testing Anthropic (claude-sonnet-4)...");
  const anthropic = await testAnthropic();
  console.log(`   ${anthropic.ok ? "✅" : "❌"} Anthropic: ${JSON.stringify(anthropic)}\n`);

  console.log("3. Testing Google (gemini-2.5-flash)...");
  const google = await testGoogle();
  console.log(`   ${google.ok ? "✅" : "❌"} Google: ${JSON.stringify(google)}\n`);

  console.log("=== Summary ===");
  const allOk = openai.ok && anthropic.ok && google.ok;
  console.log(`OpenAI:    ${openai.ok ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`Anthropic: ${anthropic.ok ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`Google:    ${google.ok ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`\nOverall: ${allOk ? "✅ ALL PASS" : "❌ SOME FAILED"}`);
  
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});

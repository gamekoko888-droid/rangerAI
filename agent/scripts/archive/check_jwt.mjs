import { logger } from './lib/logger.mjs';
import { loadEnvFile } from "./lib/bootstrap.mjs";
loadEnvFile("/opt/rangerai-agent/agent-secrets.env");

const jwtSecret = process.env.JWT_SECRET || process.env.RANGERAI_JWT_SECRET || 'rangerai-jwt-secret-2026';
logger.info("JWT_SECRET_SET:", !!process.env.JWT_SECRET);
logger.info("RANGERAI_JWT_SECRET_SET:", !!process.env.RANGERAI_JWT_SECRET);
logger.info("EFFECTIVE_SECRET_LEN:", jwtSecret.length);
logger.info("EFFECTIVE_SECRET_PREFIX:", jwtSecret.slice(0, 15));

// Now generate a proper token and test search
import crypto from 'crypto';
import { initDatabase, generateToken, verifyToken, extractUserFromRequest } from "./database.mjs";

await initDatabase();

const token = generateToken({userId: "23a770ce-7588-46e6-a2bb-5d778f9dece0", username: "jianwufy"});
logger.info("TOKEN_LEN:", token.length);

// Simulate HTTP request
const mockReq = {
  headers: {
    authorization: `Bearer ${token}`
  }
};

const user = await extractUserFromRequest(mockReq);
logger.info("EXTRACT_USER:", user ? user.username : "FAILED");

// Now test the actual API
const resp = await fetch('http://localhost:3002/api/knowledge/search', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ query: 'RangerAI', limit: 3 }),
});

logger.info("SEARCH_STATUS:", resp.status);
const data = await resp.json();
logger.info("SEARCH_RESULT:", JSON.stringify(data).slice(0, 500));

process.exit(0);

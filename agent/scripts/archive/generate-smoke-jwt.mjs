import { loadEnvFile, loadSecretsJson } from './lib/bootstrap.mjs';
import { initAdapter, query } from './db-adapter.mjs';
import { generateToken } from './services/user-service.mjs';

// Load env EXACTLY the same way as api-server.mjs
const RANGERAI_ENV_FILE = process.env.RANGERAI_ENV_FILE || "/opt/rangerai-agent/.env";
const RANGERAI_SECRETS_FILE = process.env.RANGERAI_SECRETS_FILE || "/opt/rangerai-agent/agent-secrets.env";
const RANGERAI_SECRETS_JSON = process.env.RANGERAI_SECRETS_JSON || "/opt/rangerai-agent/secrets.json";

loadEnvFile(RANGERAI_ENV_FILE);
loadEnvFile(RANGERAI_SECRETS_FILE);
const SECRETS = loadSecretsJson(RANGERAI_SECRETS_JSON);
for (const [key, val] of Object.entries(SECRETS)) {
  if (process.env[key] === undefined && typeof val === "string") {
    process.env[key] = val;
  }
}

await initAdapter();
const rows = await query('SELECT id, username, role FROM users WHERE role=? AND isActive=1 LIMIT 1', ['admin']);
const admin = rows[0];
if (admin == null) {
  console.error('No active admin user found');
  process.exit(1);
}
const token = generateToken({ userId: admin.id, username: admin.username, role: admin.role }, 1);
console.log(token);
process.exit(0);

// R54: Thin re-export shim — all sandbox logic lives in modules/sandbox-api.mjs
// This file exists only for api-server.mjs backward compatibility
export { executeCode, handleSandboxRequest, registerSandboxRoutes, setupSandboxRoutes } from '../modules/sandbox-api.mjs';

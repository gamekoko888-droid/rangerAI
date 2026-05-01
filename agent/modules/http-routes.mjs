/**
 * modules/http-routes.mjs — Backward-compat wrapper (Iter-53)
 *
 * Re-exports from http-router.mjs for any code that still imports http-routes.mjs.
 * The actual implementation is now split across:
 *   - modules/http-router.mjs (thin dispatcher)
 *   - modules/routes/infra-routes.mjs
 *   - modules/routes/admin-routes.mjs
 *   - modules/routes/task-routes.mjs
 *   - modules/routes/static-routes.mjs
 */
export { init, handleRequest } from './http-router.mjs';

/**
 * mcp-api.mjs — MCP Server Management API (P3)
 * 
 * HTTP endpoints for managing MCP servers and dynamic skills.
 * 
 * @version 1.0.0
 */
import { logger } from "../lib/logger.mjs";
import { ts } from "../modules/helpers.mjs";
import { 
  registerSkill, unregisterSkill, 
  getMCPServers, addMCPServer, removeMCPServer,
  getAvailableSkills, getAvailableTools
} from "../skills-discovery.mjs";

export function setupMCPRoutes(app, authMiddleware, adminMiddleware) {
  // GET /api/tools — List all available tools and skills
  app.get('/api/tools', authMiddleware, (req, res) => {
    const skills = getAvailableSkills();
    const tools = getAvailableTools();
    res.json({ skills, tools });
  });
  
  // POST /api/tools/register — Register a custom skill (admin only)
  app.post('/api/tools/register', adminMiddleware, (req, res) => {
    const { name, displayName, description, emoji, homepage } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing skill name' });
    
    const result = registerSkill({ name, displayName, description, emoji, homepage });
    res.json({ success: result });
  });
  
  // DELETE /api/tools/unregister/:name — Unregister a custom skill (admin only)
  app.delete('/api/tools/unregister/:name', adminMiddleware, (req, res) => {
    const result = unregisterSkill(req.params.name);
    res.json({ success: result });
  });
  
  // GET /api/mcp/servers — List MCP servers
  app.get('/api/mcp/servers', authMiddleware, (req, res) => {
    const servers = getMCPServers();
    res.json({ servers });
  });
  
  // POST /api/mcp/servers — Add MCP server (admin only)
  app.post('/api/mcp/servers', adminMiddleware, (req, res) => {
    const { name, command, args, env } = req.body;
    if (!name || !command) return res.status(400).json({ error: 'Missing name or command' });
    
    const result = addMCPServer(name, { command, args, env });
    res.json({ success: result });
  });
  
  // DELETE /api/mcp/servers/:name — Remove MCP server (admin only)
  app.delete('/api/mcp/servers/:name', adminMiddleware, (req, res) => {
    const result = removeMCPServer(req.params.name);
    res.json({ success: result });
  });
  
  logger.info(`[${ts()}] [mcp-api] Routes registered`);
}

export default { setupMCPRoutes };

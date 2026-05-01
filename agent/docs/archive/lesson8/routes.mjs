// API Routes Configuration
import { Router } from "express";

const router = Router();

// Auth routes
router.post("/api/auth/login", handleLogin);
router.post("/api/auth/register", handleRegister);
router.post("/api/auth/logout", handleLogout);
router.get("/api/auth/me", requireAuth, handleMe);

// Chat routes
router.get("/api/chats", requireAuth, listChats);
router.post("/api/chats", requireAuth, createChat);
router.get("/api/chats/:id", requireAuth, getChat);
router.delete("/api/chats/:id", requireAuth, deleteChat);
router.patch("/api/chats/:id/tags", requireAuth, updateTags);

// Message routes
router.get("/api/chats/:id/messages", requireAuth, listMessages);
router.post("/api/chats/:id/messages", requireAuth, sendMessage);

// Search routes
router.get("/api/chats/search", requireAuth, searchChats);

// Admin routes
router.get("/admin/users", requireAdmin, listUsers);
router.post("/admin/invite-codes", requireAdmin, createInviteCode);
router.get("/admin/stats", requireAdmin, getStats);

// Health check
router.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

export default router;

// ─── Agent Worker Entry Point (thin wrapper) ─────────────────
// This file is the fork target for WorkerManager.
// All logic lives in worker/index.mjs — this file just re-exports it.
// Keeping this filename unchanged avoids touching context.mjs or systemd config.
// ─────────────────────────────────────────────────────────────

import "./worker/index.mjs";

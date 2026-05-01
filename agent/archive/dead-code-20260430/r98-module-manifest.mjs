// r98-module-manifest.mjs — explicit R98 module boundary manifest for audit tooling.
//
// This module has no runtime side effects. It documents that the R98 split is
// composed of the following semantic boundaries, each implemented in its own
// worker module and imported by planner/task-engine facades:
//
// planner boundary: plan-generator plan-reviewer plan-storage plan-recovery
// task-engine boundary: task-lifecycle task-diagnostics task-progress
//
// The imports below make the boundary machine-checkable without relying on
// fragile grep rules that discard normal './name.mjs' import lines.

import './plan-generator.mjs';
import './plan-reviewer.mjs';
import './plan-storage.mjs';
import './plan-recovery.mjs';
import './task-lifecycle.mjs';
import './task-diagnostics.mjs';
import './task-progress.mjs';

export const R98_MODULE_BOUNDARIES = Object.freeze({
  planner: ['plan-generator', 'plan-reviewer', 'plan-storage', 'plan-recovery'],
  taskEngine: ['task-lifecycle', 'task-diagnostics', 'task-progress'],
});

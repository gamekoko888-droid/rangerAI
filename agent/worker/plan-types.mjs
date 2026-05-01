// plan-types.mjs — Shared JSDoc typedefs for structured planner modules
// R98 extraction: moved typedefs out of planner.mjs to keep planner as a thin facade.

/**
 * @typedef {Object} PlanStep
 * @property {string} id          - Unique step ID (e.g., "1", "2", "3")
 * @property {string} title       - Human-readable step description
 * @property {"pending"|"doing"|"done"|"failed"|"blocked"|"retrying"|"skipped"} status
 * @property {string[]} [tools]   - Expected tools for this step
 * @property {string} [rationale] - Why this step is needed
 * @property {string} [output]    - Summary of step output (filled after completion)
 * @property {string} [blockReason] - Why this step is blocked (if status=blocked)
 */

/**
 * @typedef {Object} StructuredPlan
 * @property {number} plan_version    - Plan schema version (increments on replan)
 * @property {string} reflection      - Planner's reasoning about the task
 * @property {string} goal            - User's high-level objective
 * @property {PlanStep[]} steps       - Ordered list of steps
 * @property {string} currentStepId   - ID of the step currently being executed
 * @property {string[]} doneCriteria  - Conditions that define task completion
 * @property {string[]} notes         - Planner observations / caveats
 * @property {boolean} needsReplan    - Whether the plan needs revision
 * @property {number} version         - Internal plan version (increments on each update)
 * @property {number} createdAt       - Timestamp of initial plan creation
 * @property {number} updatedAt       - Timestamp of last update
 */

export {};

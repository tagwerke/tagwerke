// Task-tree constants shared by client and server (SUBTASKS_PLAN D9).

/**
 * How deep nesting may go, counting the root as depth 0 — so a root may have children,
 * grandchildren, great-grandchildren and no further.
 *
 * A limit exists for two reasons. Practically, a task tree deeper than this stops being a
 * deliverable broken into work and becomes an outline nobody can hold in their head; every tool
 * that allows unlimited depth ends up with users asking for a way to flatten it. Mechanically, a
 * bound lets every tree walk — render, delete, restore, the ancestor check — carry a cheap
 * termination guard instead of trusting the data to be acyclic.
 *
 * Enforced server-side in parentAllowed() (routes/tasks.ts), which rejects a re-parent that would
 * exceed it; the client's Tab key checks the same value so the key is a no-op rather than a
 * round-trip that fails.
 */
export const MAX_TASK_DEPTH = 4;

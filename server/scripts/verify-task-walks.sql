-- SUBTASKS_PLAN P3 — verification for the recursive tree walks in server/routes/tasks.ts:
-- parentRefusal() (same-board + cycle + depth) and the subtree delete/restore pair.
--
-- Like verify-task-tree.sql this is a .sql file on purpose: it writes fixture rows, so it must
-- never be pointable at a real database via DATABASE_URL. Run against a throwaway PG that has had
-- the migrations applied — see the header of verify-task-tree.sql for the container recipe, then:
--
--   docker cp server/scripts/verify-task-walks.sql tw-migtest:/tmp/w.sql
--   docker exec -i tw-migtest psql -U postgres -d migtest -f /tmp/w.sql
--
-- The two checks worth reading carefully:
--   H — restoring a parent must bring back ONLY the descendants trashed by the SAME act. A child
--       someone trashed separately, earlier, has to stay in the Trash where they left it.
--   I — a walk over data that is ALREADY cyclic (a row written before the cycle guard existed)
--       must terminate at the depth bound rather than spin forever.

\pset pager off
\set ON_ERROR_STOP off

INSERT INTO users (id, email) VALUES ('u1','u1@e.com');
INSERT INTO tabs (id, name) VALUES ('B1','Board One');
-- A chain r -> c1 -> c2 -> c3 -> c4 (depths 0..4), plus a lone root and a second branch.
INSERT INTO tasks (id, home_tab_id, parent_task_id, text, rank) VALUES
  ('r',  'B1', NULL, 'root',   'a0'),
  ('c1', 'B1', 'r',  'lvl1',   'a0'),
  ('c2', 'B1', 'c1', 'lvl2',   'a0'),
  ('c3', 'B1', 'c2', 'lvl3',   'a0'),
  ('c4', 'B1', 'c3', 'lvl4',   'a0'),
  ('b1', 'B1', 'r',  'branch', 'a1'),
  ('lone','B1', NULL,'lone',   'a1');

\echo '=== A. ancestor chain length for each candidate parent (parent_chain) ==='
\echo '    expect r=1, c1=2, c2=3, c3=4, c4=5'
WITH RECURSIVE anc AS (
  SELECT id, parent_task_id, home_tab_id, 1 AS d FROM tasks WHERE id = 'c3'
  UNION ALL
  SELECT t.id, t.parent_task_id, t.home_tab_id, anc.d + 1
    FROM tasks t JOIN anc ON t.id = anc.parent_task_id WHERE anc.d < 6
)
SELECT 'c3 as parent' AS candidate, max(d) AS parent_chain FROM anc;

\echo '=== B. subtree height of the task being MOVED ==='
\echo '    expect: moving c1 carries height 3 (c2,c3,c4); moving lone carries 0'
WITH RECURSIVE descn AS (
  SELECT id, 0 AS d FROM tasks WHERE id = 'c1'
  UNION ALL
  SELECT t.id, descn.d + 1 FROM tasks t JOIN descn ON t.parent_task_id = descn.id
   WHERE descn.d < 6 AND t.deleted_at IS NULL
) SELECT 'c1' AS moved, coalesce(max(d),0) AS subtree_height FROM descn
UNION ALL
SELECT 'lone', coalesce(max(d),0) FROM (
  WITH RECURSIVE d2 AS (
    SELECT id, 0 AS d FROM tasks WHERE id = 'lone'
    UNION ALL
    SELECT t.id, d2.d + 1 FROM tasks t JOIN d2 ON t.parent_task_id = d2.id WHERE d2.d < 6
  ) SELECT d FROM d2
) x;

\echo '=== C. CYCLE detection: nesting r under its own descendant c2 ==='
\echo '    expect creates_cycle = true'
WITH RECURSIVE anc AS (
  SELECT id, parent_task_id, 1 AS d FROM tasks WHERE id = 'c2'
  UNION ALL
  SELECT t.id, t.parent_task_id, anc.d + 1 FROM tasks t JOIN anc ON t.id = anc.parent_task_id WHERE anc.d < 6
) SELECT bool_or(id = 'r') AS creates_cycle FROM anc;

\echo '=== D. no cycle when nesting lone under c2 (expect false/null) ==='
WITH RECURSIVE anc AS (
  SELECT id, parent_task_id, 1 AS d FROM tasks WHERE id = 'c2'
  UNION ALL
  SELECT t.id, t.parent_task_id, anc.d + 1 FROM tasks t JOIN anc ON t.id = anc.parent_task_id WHERE anc.d < 6
) SELECT bool_or(id = 'lone') AS creates_cycle FROM anc;

\echo '=== E. DEPTH rule: parent_chain + subtree_height <= 4 ==='
\echo '    lone under c3 -> 4 + 0 = 4  => ALLOWED'
\echo '    lone under c4 -> 5 + 0 = 5  => REFUSED'
\echo '    c1   under c1 is a cycle; c1 under b1 -> 2 + 3 = 5 => REFUSED'
SELECT 'lone under c3' AS move, 4 + 0 AS deepest, (4 + 0) <= 4 AS allowed
UNION ALL SELECT 'lone under c4', 5 + 0, (5 + 0) <= 4
UNION ALL SELECT 'c1 under b1',   2 + 3, (2 + 3) <= 4;

\echo '=== F. live descendants of r, for subtree DELETE (expect c1,c2,c3,c4,b1) ==='
WITH RECURSIVE descn AS (
  SELECT id, 0 AS d FROM tasks WHERE id = 'r'
  UNION ALL
  SELECT t.id, descn.d + 1 FROM tasks t JOIN descn ON t.parent_task_id = descn.id
   WHERE descn.d < 6 AND t.deleted_at IS NULL
) SELECT id FROM descn WHERE d > 0 ORDER BY id;

\echo '=== G. trash c2 SEPARATELY first, then trash the whole r subtree ==='
UPDATE tasks SET deleted_at = '2026-07-01 00:00:00+00', deleted_by = 'u1' WHERE id IN ('c2','c3','c4');
UPDATE tasks SET deleted_at = '2026-07-25 12:00:00+00', deleted_by = 'u1'
 WHERE id IN ('r','c1','b1') AND deleted_at IS NULL;

\echo '=== H. restoring r must bring back ONLY the co-deleted sweep (expect c1,b1 — NOT c2/c3/c4) ==='
WITH RECURSIVE descn AS (
  SELECT id, 0 AS d FROM tasks WHERE id = 'r'
  UNION ALL
  SELECT t.id, descn.d + 1 FROM tasks t JOIN descn ON t.parent_task_id = descn.id
   WHERE descn.d < 6 AND t.deleted_at = '2026-07-25 12:00:00+00'
) SELECT id FROM descn WHERE d > 0 ORDER BY id;

\echo '=== I. a pre-existing CYCLE must not hang the walk (bounded) ==='
UPDATE tasks SET deleted_at = NULL WHERE id IN ('r','c1','c2','c3','c4','b1');
UPDATE tasks SET parent_task_id = 'c4' WHERE id = 'r';
WITH RECURSIVE anc AS (
  SELECT id, parent_task_id, 1 AS d FROM tasks WHERE id = 'c2'
  UNION ALL
  SELECT t.id, t.parent_task_id, anc.d + 1 FROM tasks t JOIN anc ON t.id = anc.parent_task_id WHERE anc.d < 6
) SELECT count(*) AS rows_walked, max(d) AS max_depth FROM anc;
\echo '    (terminated at the bound instead of spinning — that is the point)'

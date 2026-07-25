-- SUBTASKS_PLAN P2 — verification for the task-tree constraints added in migration 0026.
--
-- Deliberately a .sql file and NOT a tsx script that reads DATABASE_URL: it INSERTs and DELETEs
-- fixture rows, so it must never be possible to point it at a real database by accident. Run it
-- against a throwaway Postgres that has had the migrations applied:
--
--   docker run -d --name tw-migtest -e POSTGRES_PASSWORD=test -e POSTGRES_DB=migtest \
--     -p 55499:5432 postgres:17-alpine
--   DATABASE_URL="postgres://postgres:test@localhost:55499/migtest" npx drizzle-kit migrate
--   docker cp server/scripts/verify-task-tree.sql tw-migtest:/tmp/t.sql
--   docker exec -i tw-migtest psql -U postgres -d migtest -f /tmp/t.sql
--   docker rm -f tw-migtest
--
-- Checks 3, 5 and 8 are EXPECTED to print an ERROR — that is the constraint doing its job.
-- Check 6 is the one that actually needed proving: two foreign keys cover parent_task_id with
-- different delete actions, and their firing order decides whether hard-deleting a parent works
-- at all. It passes because NO ACTION defers to end-of-statement (RESTRICT would not).

\set ON_ERROR_STOP off
\pset pager off

INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com');
INSERT INTO tabs (id, name) VALUES ('B1', 'Board One'), ('B2', 'Board Two');
INSERT INTO tasks (id, home_tab_id, text, rank) VALUES
  ('t_parent', 'B1', 'Parent on B1', 'a0'),
  ('t_child',  'B1', 'Child on B1',  'a1'),
  ('t_other',  'B2', 'Task on B2',   'a0');

\echo '--- 1. rank column collation (expect: C) ---'
SELECT c.collname AS rank_collation
FROM pg_attribute a
JOIN pg_class t ON t.oid = a.attrelid
LEFT JOIN pg_collation c ON c.oid = a.attcollation
WHERE t.relname = 'tasks' AND a.attname = 'rank';

\echo '--- 2. same-board nesting is ALLOWED (expect: UPDATE 1) ---'
UPDATE tasks SET parent_task_id = 't_parent' WHERE id = 't_child';

\echo '--- 3. CROSS-board nesting is REJECTED (expect: violation of tasks_parent_same_board) ---'
UPDATE tasks SET parent_task_id = 't_parent' WHERE id = 't_other';

\echo '--- 4. a root (null parent) passes freely (expect: UPDATE 1) ---'
UPDATE tasks SET parent_task_id = NULL WHERE id = 't_other';

\echo '--- 5. dragging a CHILD to another board while its parent stays is REJECTED (expect: violation) ---'
UPDATE tasks SET home_tab_id = 'B2' WHERE id = 't_child';

\echo '--- 6. INTERPLAY: hard-deleting a parent must NOT violate the composite FK (expect: DELETE 1) ---'
DELETE FROM tasks WHERE id = 't_parent';

\echo '--- 7. the child survived and was promoted to root (expect: t_child with a NULL parent) ---'
SELECT id, home_tab_id, parent_task_id FROM tasks ORDER BY id;

\echo '--- 8. a parent that does not exist is REJECTED (expect: violation of the single-column FK) ---'
UPDATE tasks SET parent_task_id = 'does_not_exist' WHERE id = 't_child';

\echo '--- 9. tree indexes present (expect tasks_parent_idx and tasks_tree_idx) ---'
SELECT indexname FROM pg_indexes WHERE tablename = 'tasks' ORDER BY indexname;

\echo '--- 10. C collation orders ranks by byte value (expect A0 < Z0 < a0 < z0) ---'
\echo '---     Under a locale collation these interleave and the DB would disagree with the client. ---'
SELECT r FROM (VALUES ('z0'),('a0'),('Z0'),('A0')) v(r) ORDER BY r COLLATE "C";

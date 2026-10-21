---
name: tagwerke
description: Read and write the user's Tagwerke boards (tasks, sub-tasks, comments, sprints, boards) through their personal access token. Use whenever the user mentions Tagwerke, a Tagwerke board or task, or asks to add, update, review or reconcile items in Tagwerke.
---

# Tagwerke from Claude Code

Tagwerke is the team's task tracker. This skill lets you read and write it directly, as the
user, with their personal access token (PAT). Everything you write is recorded in Tagwerke's audit
log as the user, tagged "via token" — so act as carefully as they would.

## Setup (the human does this once)

1. In Tagwerke: click your name (bottom-left) → **Security** → **Personal access tokens** → **New token**.
2. Name it (e.g. "Claude Code"), pick an expiry, tick what it may **write**: *Create and edit tasks*,
   *Comment on tasks*, and (optional) *Create boards…*. Reading is always allowed.
3. Boards: tick **All my boards, including future ones**, or tick specific boards. **A new token
   reaches no boards until you tick some.**
4. Confirm your sign-in. Copy the token — it is shown **once**.
5. Put it in your environment, never in a file that gets committed and never in chat:
   ```sh
   export TAGWERKE_URL=https://tagwerke.knyazev.ca
   export TAGWERKE_TOKEN=tgw_pat_...
   ```
   To change what a token can do, create a new one and revoke the old one (Security → ✕).

A token can never touch secrets, members/sharing, board settings, account security, or other
people's boards. It never does more than the user could.

## How to call it

Needs `curl` and `jq`. Every request: `Authorization: Bearer $TAGWERKE_TOKEN`, JSON bodies. Define a helper first:

```sh
tgw() { curl -sS -H "Authorization: Bearer $TAGWERKE_TOKEN" -H 'content-type: application/json' "$@"; }
```

Start every session by listing what you can reach (this is also how you find ids):

```sh
tgw $TAGWERKE_URL/api/state > /tmp/tgw-state.json
jq -r '.tabs | to_entries[] | "\(.key)\t\(.value.name)\t\(.value.role)"' /tmp/tgw-state.json   # boards
jq -r '.sprintsByBoard["BOARD_ID"][] | "\(.id)\t\(.label)\t\(.isCurrent)"' /tmp/tgw-state.json  # sprints
jq -r '.membersByBoard["BOARD_ID"][] | "\(.id)\t\(.email)"' /tmp/tgw-state.json                 # people
jq -r '.tasks[] | select(.homeTabId=="BOARD_ID") | "\(.id)\t\(.status)\t\(.parentTaskId // "-")\t\(.text)"' /tmp/tgw-state.json
```

`/api/state` returns: `tabs` (boards, with your `role`), `tasks` (every task, keyed by id),
`membersByBoard`, `sprintsByBoard`, `commentCounts`, and `projects` (your own categories). Only boards
the token reaches appear. If a board you expect is missing, the token wasn't ticked for it — ask the
user for a new token; don't guess ids.

## Tasks

A task has: `text` (the title), `description`, `status`, `assigneeId`, `reviewerId`, `date`
(due, `YYYY-MM-DD`), `priority`, `parentTaskId`, `sprintId`, and a board (`homeTabId`).

- **status**: `todo`, `in_progress`, `in_review`, `done`, `cancelled`. `in_review` is just a status
  (there is no approval gate); `reviewerId` says who should look.
- **priority**: `3` is the **highest** (shown "!!!"), `1` the lowest. Not the P1-is-urgent convention.
- **assignee / reviewer** must be a member of that board (ids from `membersByBoard`). There are no
  labels or tags: if a person isn't a member, put their name in the title.
- **sub-tasks**: set `parentTaskId` to a task on the **same board**; up to 4 levels deep. Create the
  parent before its children. Children do not inherit sprint or due date, and a parent's status does
  not follow its children.
- **sprint**: `sprintId` from `sprintsByBoard`, or omit/`null` for the backlog.

### Create — `PUT /api/tasks/{id}`

You choose the id: any unique string (e.g. `t_` + 8 random characters, or a stable key like
`ih-V07` — handy so a re-run finds the same task).

```sh
tgw -X PUT $TAGWERKE_URL/api/tasks/t_ab12cd34 -d '{
  "homeTabId": "BOARD_ID",
  "text": "Rotate the SES keys",
  "description": "Owner: Kirill",
  "status": "todo",
  "priority": 3,
  "date": "2026-10-31",
  "assigneeId": "USER_ID",
  "sprintId": "SPRINT_ID",
  "parentTaskId": "PARENT_ID"
}'
```

⚠️ `PUT` is create-or-**replace**. Re-sending an existing id rewrites it: assignee, reviewer, due
date and priority you leave out are **cleared**. **Never use PUT to edit.** Never reuse an id that
belongs to another board.

### Edit — `PATCH /api/tasks/{id}` (partial; only the fields you send)

```sh
tgw -X PATCH $TAGWERKE_URL/api/tasks/t_ab12cd34 -d '{"status":"in_progress","assigneeId":"USER_ID"}'
tgw -X PATCH $TAGWERKE_URL/api/tasks/t_ab12cd34 -d '{"parentTaskId":"PARENT_ID"}'   # re-parent
tgw -X PATCH $TAGWERKE_URL/api/tasks/t_ab12cd34 -d '{"date":null}'                  # null clears a field
```

### Other task actions

- Move to another board: `POST /api/tasks/{id}/move` `{"toTabId":"BOARD_ID"}` (carries sub-tasks; the
  sprint and any assignee who isn't on the new board are cleared — the response says how many).
- Delete: `DELETE /api/tasks/{id}` (soft delete, with its sub-tasks, recoverable). Restore:
  `POST /api/tasks/{id}/restore`. Trash list: `GET /api/tabs/{boardId}/trash`.
- History: `GET /api/tasks/{id}/history`, `GET /api/tabs/{boardId}/history`.

## Comments

```sh
tgw $TAGWERKE_URL/api/tasks/TASK_ID/comments                                  # read the thread
tgw -X POST $TAGWERKE_URL/api/tasks/TASK_ID/comments -d '{"id":"c_1a2b3c4d","body":"Verified 2026-10-21: key rotated, old key disabled."}'
```

`id` is yours (unique, ≤64 chars; a retry with the same id is safe). Mention someone with
`@[Name](USER_ID)` — they get a notification. You can edit (`PATCH /api/comments/{id}` `{"body":…}`) or
delete (`DELETE /api/comments/{id}`) **only your own** comments, and only through this token.

## Boards and sprints (needs the *boards* permission)

```sh
# new board: projectId is one of the keys of .projects in /api/state; position is a number >= 0
tgw -X POST $TAGWERKE_URL/api/tabs -d '{"id":"b_9f8e7d6c","projectId":"PROJECT_ID","name":"Lockdown checklist","position":0}'
tgw -X PATCH $TAGWERKE_URL/api/tabs/BOARD_ID -d '{"name":"New name"}'            # rename
tgw $TAGWERKE_URL/api/tabs/BOARD_ID/sprints                                       # list sprints
tgw -X PATCH $TAGWERKE_URL/api/sprints/SPRINT_ID -d '{"label":"Week 43"}'         # rename
tgw -X PATCH $TAGWERKE_URL/api/sprints/SPRINT_ID -d '{"isCurrent":true}'          # make current
```

A board you create through the token is added to the token automatically. Sprints are weekly and
created for you; there is no create-sprint call.

## What you cannot do (don't try)

Members, sharing or roles; board settings; secrets; documents; the board's Notes (readable with
`GET /api/tabs/{id}/doc`, but edited only in the app); calendar events; CSV import; deleting boards
or sprints; reordering boards; token management. Those return 403/404 by design — tell the user to do
them in the app.

## Working rules

- **Look before you write.** Fetch `/api/state` first; match existing tasks by title/id before creating,
  to avoid duplicates.
- **Show a plan for anything bigger than a couple of edits** (a table of what you'll create/change) and
  get a yes before writing. Then write one task at a time and re-read the board to confirm.
- **Never put credentials, keys, tokens or personal data in a title, description or comment.** They are
  stored as plain text and copied into the audit log. Refer to *where* a secret lives, not what it is.
- **Don't delete** without being asked. Prefer `status: cancelled` plus a comment saying why.
- **Record verification in comments** ("what was checked, when, how"), not in the title.
- Dates are `YYYY-MM-DD`; sprints don't set due dates.

## Errors

| Response | Meaning |
|---|---|
| `401 unauthenticated` | Token wrong, expired or revoked. Ask for a new one (Security → New token). |
| `403 not available to tokens` | That route is deliberately closed to tokens (see above). |
| `403 insufficient scope` | The token wasn't ticked to write this kind of thing. New token. |
| `403 insufficient permission` | You're only a viewer on that board. |
| `404 not found` | The token doesn't reach that board (not ticked), or the id is wrong. Check `/api/state`. |
| `400 …` | The body was invalid (e.g. assignee not on the board, parent on another board, nesting too deep). |

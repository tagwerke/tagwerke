# Access tokens

Tagwerke has two kinds of API token. Both are created in the app, shown once, and stored only as a
hash. Send them as `Authorization: Bearer <token>`.

| | Personal access token | Board API token |
|---|---|---|
| Prefix | `tgw_pat_` | `tgw_agent_` |
| Acts as | **You** (writes are attributed to you) | A bot user bound to one board |
| Where | Security → Personal access tokens | Share → API tokens (board admins) |
| API | The normal `/api/*` routes | `/api/agent/*` |
| Reaches | The boards you tick, or all your boards including future ones | That one board |

A token can never reach board secrets, your account security (password, 2FA, passkeys, sessions),
token management, member management, board settings or the admin console, whatever is ticked.
Creating a token needs a fresh sign-in (password, 2FA code or passkey). Revoking never does.
Tokens expire after 30, 90 or 365 days; there is no "never".

## Personal access tokens

You choose what the token may **write**; reading the boards you tick is always allowed.

| Permission | Lets it |
|---|---|
| `tasks` | Create, edit, delete, restore and move tasks (assignee, sprint, status, priority, parent) |
| `comments` | Post comments, and edit or delete **its own** |
| `boards` | Create boards, rename them, rename sprints and set the current one |

Nothing is ticked by default, and a new token reaches **no boards** until you tick some. A board the
token creates is added to its list automatically. Your own role on each board is checked on every
request, so a token never does more than you could (a token on a board you only view can't edit it). Every write is recorded in the audit log with the token's name (`via: pat`), and you
get a notification when a token is created.

```sh
export TAGWERKE_TOKEN=tgw_pat_...
curl -H "Authorization: Bearer $TAGWERKE_TOKEN" https://your-tagwerke/api/state
```

`/api/state` is the way to find board, sprint and member ids. Board creation needs one of your
category ids from its `projects` map.

## Using a token from Claude Code

[`docs/claude-code/SKILL.md`](claude-code/SKILL.md) is a ready-made Claude Code skill: drop it in
`~/.claude/skills/tagwerke/SKILL.md`, set `TAGWERKE_URL` and `TAGWERKE_TOKEN`, and Claude can read and
write your boards directly (tasks, sub-tasks, comments, sprints) with the right guard rails.

## Board API tokens

For a project's agent. Pick **comment** and/or **create and edit tasks** when you create it. The agent
reads its board and works through `/api/agent/*` (see the Agent API notes). It cannot mark a task
done, delete anything, or touch members, settings, documents or secrets. It appears in Share with a
"bot" badge; revoking the token removes it from the board.

## Self-hosting notes

Nothing to configure. Migration `0035` adds the table on boot. Tokens use the same session secret
and database as the rest of the app; there is no extra service.

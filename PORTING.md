# Porting to zombi.dev

Zombi Roles will later become a tool inside zombi.dev, which is Laravel 13 with the React starter kit on Namecheap shared hosting. Shared hosting can't keep a bot connected, so the bot becomes an HTTP interactions endpoint, with batches run by a queue and a cron job.

## What moves where

`src/core` holds no Discord or disk code, and its tests in `test/` describe the expected behavior, so they are the checklist for the port.

| Today | In zombi.dev |
|---|---|
| `src/core/names.js`, `match.js`, `invite.js`, `role-input.js`, `autofill.js` | Plain PHP service classes, such as `App\Services\ZombiRoles` |
| `src/core/plan.js`, `roles.js`, `undo.js`, `report.js`, `results.js` | PHP service classes |
| `src/core/runner.js` | A queued Laravel job, driven by cron. See below |
| `src/discord/client.js` | A small class using Laravel's HTTP client |
| `src/discord/gateway.js` | Removed. An interactions route replaces it |
| `src/bot/rolebatch.js`, `messages.js` | Controller and service for the interactions route. Message payloads carry over nearly unchanged |
| `src/panel/server.js`, `batches.js`, `settings.js` | Laravel controllers, Eloquent models, and config. Replaced by the site's login and permissions |
| `public/` | React pages with the same step flow and zombi.dev components. The tokens already match |
| `launcher.mjs`, `starters/`, `src/update/`, `scripts/release*.js` | Removed. Deployment replaces them |

## What changes

- **Interactions:** Discord posts each command to a URL. Verify the Ed25519 signature on every request and answer `PING`, or Discord will refuse the endpoint. Reply within 3 seconds, deferring anything slower.
- **Pacing:** the runner's loop can't run for hours on shared hosting. Store each change as a database row, and have cron run a short job that processes a few, sleeping about a second between changes. Honor `retry_after` by recording when work may continue.
- **Stop and resume:** a status field on the batch replaces the abort signal. Pending rows are what resumes.
- **Results:** rows replace the CSV file, with CSV as an export. Keep the leading quote protection for spreadsheets.
- **Member list:** there's no live cache between requests, so read pages from Discord in a job and store only what a batch needs.
- **Progress:** the 15 minute reply limit still applies, so keep the direct message at the end. A cron run can edit the reply.
- **Tokens:** move the bot token to the server's environment settings.

## Privacy

zombi.dev must be GDPR compliant. Keep stored member data to names and IDs, run the retention cleanup as a scheduled job, and cover this feature in the privacy notice. Join dates were removed on purpose until the member list download in `docs/future-ideas.md` is built.

## Worth keeping

- The Server Members intent matters less over HTTP, but reading members still needs the privileged intent turned on for the application.
- `members-search` is unsupported by Discord, so keep it labeled experimental.
- Never guess a name, and never apply anything without a preview.

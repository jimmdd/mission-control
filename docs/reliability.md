# Runtime reliability

The server, Linear poller, and bridge must run the same checkout after schema or lifecycle changes. Restart long-lived server/bridge processes after updating code; scheduled scripts pick up changes on their next invocation.

## Recovery boundaries

- Linear polling holds a cross-process lock. Each issue saves an atomic checkpoint, and one failed issue does not prevent the others from syncing. Failed issue IDs and errors remain in `sync/linear-state.json`; `last_sync` advances only after a clean cycle. Retries occur on the configured polling interval.
- Task reconciliation reads all API pages. Linear comment ingestion follows cursors and refuses to treat a failed/partial read as an empty thread.
- Launching a task is serialized by a task-specific lock. Register the attempt before starting its tmux session; the launcher acknowledges that attempt before executing the agent. Retries adopt only a matching task/repository/branch. An unacknowledged pane remains pending rather than being called a successful launch.
- Prompt activity and history logging are best effort. They cannot turn a successfully acknowledged launch into a failed spawn. The shell API client supports macOS Bash 3.2 with authentication both configured and absent.
- Bridge stages report failures independently, so planning failures do not suppress ticket replies or PR completion. Planning and review also isolate individual tickets. Status queues consume all API pages and failed reads remain visible in health receipts.
- After a 15-minute grace, interrupted dispatches return to planning with their decisions intact. Active processing leases and pending human checkpoints prevent recovery. Lost single-agent runs use the existing bounded retry budget; planned runs retain their step-level recovery. Dead registry attempts keep repository, branch, and worktree metadata, and retained dead tmux panes are retired only for the matching execution target under the launch lock.
- Transient spawn failures retry automatically; only an exhausted three-attempt budget opens a human checkpoint. Resolving that checkpoint starts a fresh retry round.
- `/health/live` reports HTTP liveness. `/health` returns 503 for stale/failed sync or bridge cycles, stale dispatch queues, overdue launch acknowledgements, or stale agent heartbeats. Initial missing receipts have a 15-minute startup allowance; existing stale receipts remain degraded immediately. The health helper restarts only an unresponsive server, using the installed `ai.mission-control.server` label.

## September 7 validation

The live server still had the pre-`closed` schema from August 25. MET-556's duplicate status repeatedly aborted Linear sync. A paged SQLite backup was taken before restarting the server and applying the existing migration. A controlled intake-only sync then processed all 96 fetched issues, found 95 linked MC tasks (previously 87 in the first API page), closed the duplicate locally, and finished with zero failures. No Linear mutations were used for this verification.

Validation includes the existing suite and an isolated real-tmux launch with stub agents, a two-megabyte prompt, failed optional history logging, and duplicate dispatch. The tests use local fixture repositories and do not launch a paid agent or publish a PR.

The flow regressions cover isolated bridge-stage failures, queues larger than 100 tasks, millisecond heartbeat grace, preserved recovery metadata, lease/checkpoint guards, bounded escalation, and relaunch after a retained dead tmux pane.

#!/usr/bin/env python3
"""Small, testable completion boundary used by the shell monitor."""


def completion_action(task_type: str, no_pr_mode: bool, pr_url: str,
                      pr_state: str = "OPEN", pending_checkpoint: bool = False,
                      lookup_failed: bool = False) -> str:
    """A process exit or historical PR is not evidence of current delivery."""
    if pending_checkpoint:
        return "checkpoint"
    if lookup_failed:
        return "wait"
    if task_type == "investigation" or no_pr_mode:
        return "review"
    if pr_url:
        if pr_state == "OPEN":
            return "review"
        if pr_state == "CLOSED":
            return "closed"
        if pr_state == "MERGED":
            return "merged"
        return "wait"
    return "resume"


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--task-type", default="implementation")
    parser.add_argument("--no-pr", action="store_true")
    parser.add_argument("--pr-url", default="")
    parser.add_argument("--pr-state", default="OPEN")
    parser.add_argument("--pending-checkpoint", action="store_true")
    parser.add_argument("--lookup-failed", action="store_true")
    args = parser.parse_args()
    print(completion_action(args.task_type, args.no_pr, args.pr_url, args.pr_state,
                            args.pending_checkpoint, args.lookup_failed))

#!/usr/bin/env python3
"""Small, testable completion boundary used by the shell monitor."""


def completion_action(task_type: str, no_pr_mode: bool, pr_url: str) -> str:
    """Return ``review`` only when the task has its required deliverable."""
    if task_type == "investigation" or no_pr_mode or bool(pr_url):
        return "review"
    return "resume"


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--task-type", default="implementation")
    parser.add_argument("--no-pr", action="store_true")
    parser.add_argument("--pr-url", default="")
    args = parser.parse_args()
    print(completion_action(args.task_type, args.no_pr, args.pr_url))

#!/usr/bin/env python3
"""Assemble the actual worker input without reversing local recovery scope."""
import os
from pathlib import Path
import sys

REVIEW_ONLY_SUFFIX = '''

CURRENT EXECUTION MODE: LOCAL VERIFICATION ONLY / NO-PR MODE.
Complete permitted local QA and required independent review, preserving prior decisions,
source, evidence and explicit holds. Reuse valid checks; never duplicate a running review.
Do not push, create/edit a PR, upload, post external messages, deploy, merge, change OS
security/global settings, restart shared services, or access real environments. This
recovery grants no new publication or third-party destination authorization.
Missing local proof is technical work to complete, not a human question. If a concrete
permission or conflicting product decision is required, use the existing checkpoint
protocol, describe the exact blocked action, and STOP. Never guess or bypass that gate.
Report local readiness and genuinely unverified external checks when finished.
'''


def render(prompt, default_suffix, review_only):
    return prompt + '\n' + (REVIEW_ONLY_SUFFIX if review_only else default_suffix) + '\n'


if __name__ == '__main__':
    print(render(Path(sys.argv[1]).read_text(), sys.argv[2],
                 os.environ.get('MC_REVIEW_ONLY') == '1'), end='')

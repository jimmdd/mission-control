#!/usr/bin/env python3
"""Serialize review runs and retain typed outcomes; never authorize publication."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def evidence_fingerprint(worktree):
    root = Path(worktree) / '.codex-evidence'
    digest = hashlib.sha256()
    if root.is_dir() and not root.is_symlink():
        for path in sorted(root.rglob('*')):
            if path.is_symlink() or not path.is_file() or path.name.startswith('.env'):
                continue
            digest.update(str(path.relative_to(root)).encode() + b'\0')
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def snapshot(worktree, base):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=worktree, text=True,
                                       stderr=subprocess.PIPE, timeout=30).strip()
    return {'head': git('rev-parse', 'HEAD'), 'base': git('rev-parse', base),
            'clean': not git('status', '--porcelain'),
            'evidenceFingerprint': evidence_fingerprint(worktree)}


def classify(code, output):
    verdicts = re.findall(r'^VERDICT: (PASS|FAIL|WARN)\b', output, re.M)
    reasons = re.findall(r'^REVIEW_REASON: (qa_gap|independent_review|authorization|product_decision|code_findings)\s*$', output, re.M)
    if reasons and reasons[-1] in ('authorization', 'product_decision'):
        return {'status': reasons[-1], 'nextAction': 'request_specific_decision', 'humanRequired': True}
    if 'FAIL' in verdicts:
        return {'status': 'findings', 'nextAction': 'fix_code', 'humanRequired': False}
    if code == 0 and verdicts and set(verdicts) == {'PASS'}:
        return {'status': 'complete', 'nextAction': 'none', 'humanRequired': False}
    if reasons and reasons[-1] == 'code_findings':
        return {'status': 'findings', 'nextAction': 'fix_code', 'humanRequired': False}
    if code == 2:
        return {'status': 'runner_unavailable', 'nextAction': 'bounded_readonly_diagnosis', 'humanRequired': False}
    if reasons and reasons[-1] in ('qa_gap', 'independent_review'):
        return {'status': 'incomplete', 'nextAction': 'complete_local_qa' if reasons[-1] == 'qa_gap' else 'complete_independent_review', 'humanRequired': False}
    return {'status': 'incomplete', 'nextAction': 'resolve_review_feedback', 'humanRequired': False}


def reusable(receipt, state):
    from pr_readiness import greptile_pass
    return (state['clean'] and isinstance(receipt, dict)
            and receipt.get('head') == state['head'] and receipt.get('base') == state['base']
            and receipt.get('verdict') == 'PASS'
            and re.findall(r'^VERDICT: (PASS|FAIL|WARN)\b', receipt.get('review', ''), re.M) == ['PASS']
            and receipt.get('evidenceFingerprint') == state['evidenceFingerprint']
            and greptile_pass(receipt.get('greptile'), state['head'], state['base']))


def atomic_json(path, payload):
    temp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    with open(temp, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        json.dump(payload, stream, indent=2)
    temp.replace(path)


def inherited_lock_fds():
    try:
        fd = int(os.environ.get('MC_REVIEW_LOCK_FD', '-1'))
        if fd < 3:
            return ()
        os.fstat(fd)
        return (fd,)
    except (ValueError, OSError):
        return ()


def stop_owned_group(process):
    # A shell leader may exit before its helpers. Signal the owned group even
    # after wait() reaped the leader; inherited lock ownership lasts through
    # detached CLI cleanup, so a late child cannot overlap a replacement review.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        deadline = time.monotonic() + (2 if sig == signal.SIGTERM else 1)
        while time.monotonic() < deadline:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                break
            except PermissionError:
                # Some macOS sandboxes deny signal 0 even for our own group.
                # Keep the grace period and use the actual owned-group signal;
                # an unavailable liveness probe must not mask cancellation.
                pass
            time.sleep(.02)
    process.wait(timeout=5)


def execute(script, worktree, base):
    worktree = str(Path(worktree).resolve())
    root = Path(os.environ.get('MC_HOME', str(Path.home() / '.mission-control'))) / 'swarm/pr-review-state'
    key = hashlib.sha256(worktree.encode()).hexdigest()[:24]
    runs = root / 'runs' / key
    runs.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(runs / 'review.lock', 'a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Review already running for this worktree. Wait for its retained outcome; do not launch a duplicate.')
            return 3
        state = snapshot(worktree, base)
        if not state['clean']:
            print('Commit changes before review; the worktree is not clean.', file=sys.stderr)
            return 2
        try:
            receipt = json.loads((root / f"{state['head']}.json").read_text())
        except (OSError, ValueError):
            receipt = None
        if reusable(receipt, state):
            atomic_json(runs / 'latest.json', {**state, 'worktree': worktree, 'status': 'complete',
                        'nextAction': 'none', 'humanRequired': False, 'reused': True,
                        'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
            print(f"Reused completed review for exact head {state['head']} / base {state['base']} and unchanged QA evidence.")
            print(receipt['review'])
            return 0
        run_id = f'{time.time_ns()}-{os.getpid()}'
        logfile = runs / f'{run_id}.log'
        result = {**state, 'worktree': worktree, 'baseRef': base, 'runId': run_id, 'status': 'running',
                  'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'log': str(logfile),
                  'transcripts': str(runs / run_id / 'codex')}
        atomic_json(runs / 'latest.json', result)
        env = {**os.environ, 'MC_REVIEW_GUARD_PID': str(os.getpid()),
               'MC_REVIEW_EVIDENCE_FINGERPRINT': state['evidenceFingerprint'],
               'MC_REVIEW_LOCK_FD': str(lock.fileno()), 'MC_REVIEW_ARCHIVE_DIR': result['transcripts']}
        process = None
        try:
            with open(logfile, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as output:
                process = subprocess.Popen(['bash', script, worktree, base], env=env,
                                           stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
                                           pass_fds=(lock.fileno(),))
                try:
                    code = process.wait(timeout=2 * float(env.get('PRE_REVIEW_TIMEOUT_SECONDS', '900')) + 10)
                except subprocess.TimeoutExpired:
                    code = 2
                    print('Overall review deadline exceeded; resume bounded diagnosis, not a code-fix iteration.', file=output, flush=True)
        except BaseException:
            result.update(status='interrupted', interrupted=True, nextAction='resume_review', humanRequired=False, exit=130)
            raise
        finally:
            try:
                if process is not None:
                    stop_owned_group(process)
            except (OSError, subprocess.SubprocessError) as error:
                result['cleanupError'] = str(error)
                if result['status'] != 'interrupted':
                    code = 2
                    result.update(status='runner_unavailable', nextAction='bounded_readonly_diagnosis',
                                  humanRequired=False, exit=code)
            if result.get('interrupted'):
                # Cancellation cannot erase a finding or authorization boundary
                # already emitted by a reviewer, even before its helper printed it.
                retained = logfile.read_text() if logfile.exists() else ''
                for answer in sorted(Path(result['transcripts']).glob('*/answer-*.txt')):
                    retained += '\n' + answer.read_text()
                if (re.search(r'^VERDICT: (FAIL|WARN)\b', retained, re.M)
                        or re.search(r'^REVIEW_REASON: (qa_gap|independent_review|authorization|product_decision|code_findings)\s*$', retained, re.M)):
                    result.update(classify(130, retained))
            if result.get('interrupted') or result.get('cleanupError'):
                result['endedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                atomic_json(runs / f'{run_id}.json', result)
                atomic_json(runs / 'latest.json', result)
        output = logfile.read_text()
        print(output, end='')
        result.update(classify(code, output), exit=code,
                      endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        atomic_json(runs / f'{run_id}.json', result)
        atomic_json(runs / 'latest.json', result)
        print('REVIEW_OUTCOME: ' + json.dumps({k: result[k] for k in ('status', 'nextAction', 'humanRequired', 'head', 'base', 'log')}))
        return code


if __name__ == '__main__':
    def cancel(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGHUP, cancel)
    try:
        sys.exit(execute(*sys.argv[1:]))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Review runner unavailable: {error}', file=sys.stderr)
        sys.exit(2)

#!/usr/bin/env python3
"""Send an explicitly prepared, approved brief to subscription Claude; no tools."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import time

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--brief', required=True, type=Path)
p.add_argument('--out', required=True, type=Path)
p.add_argument('--timeout', type=int, default=300)
p.add_argument('--observer-parent', default=os.environ.get('OBSERVER_PARENT_TASK_ID', ''))
p.add_argument('--observer-directory', default=os.environ.get('OBSERVER_COLLABORATION_DIR', ''))
a = p.parse_args()
claude_bin = shutil.which('claude')
if not claude_bin:
    p.error('Claude CLI is unavailable; no external call was started')
if not 30 <= a.timeout <= 900:
    p.error('timeout must be 30..900 seconds')
if any(k in os.environ for k in ('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY')):
    p.error('Provider override present. Review the billing route before calling; values were not read or logged.')
brief = a.brief.resolve()
out = a.out.resolve()
if not brief.is_file() or not 0 < brief.stat().st_size <= 100000:
    p.error('brief must be a nonempty UTF-8 file <=100000 bytes containing only approved data')
if out.exists() or out.with_suffix(out.suffix+'.meta.json').exists():
    p.error('choose a fresh output name; existing results are not overwritten')
if os.environ.get('OBSERVER_MANAGED_RUN') != '1':
    recorder = Path(__file__).resolve().parents[1] / 'server/collaboration-cli.js'
    node = shutil.which('node')
    if not node or not recorder.is_file():
        p.error('local collaboration recorder is unavailable; no external call was started')
    common = ['--directory', a.observer_directory] if a.observer_directory else []
    task = {
        'title': 'Claude review: ' + brief.stem,
        'executor': 'claude',
        'brief': brief.read_text(),
        'cwd': str(brief.parent),
        'permission': 'patch',
        'writePaths': [str(out), str(out.with_suffix(out.suffix+'.meta.json'))],
    }
    if a.observer_parent:
        task['parentTaskId'] = a.observer_parent
    created = subprocess.run([node, str(recorder), 'create', '--input', '-', *common],
                             input=json.dumps(task), capture_output=True, text=True)
    if created.returncode:
        p.exit(1, 'Recorder could not create the task; no external call was started.\n' + created.stderr)
    task_id = json.loads(created.stdout)['id']
    print(json.dumps({'observer_task_id': task_id, 'acceptance': 'pending Codex verification'}), flush=True)
    managed = subprocess.run([
        node, str(recorder), 'run', task_id, *common,
        '--timeout', str(a.timeout + 15), '--brief-file', str(brief),
        '--result-file', str(out), '--metadata-file', str(out.with_suffix(out.suffix+'.meta.json')),
        '--', sys.executable, str(Path(__file__).resolve()), '--brief', str(brief), '--out', str(out), '--timeout', str(a.timeout),
    ])
    raise SystemExit(managed.returncode)
auth = subprocess.run([claude_bin,'auth','status'], capture_output=True, text=True, timeout=30)
try:
    status = json.loads(auth.stdout)
except ValueError:
    p.error('cannot establish current Claude authentication; use the regular login UI')
if not status.get('loggedIn') or status.get('authMethod') != 'claude.ai' or status.get('subscriptionType') not in ('pro','max'):
    p.error('a verified Claude subscription login is required; no API fallback is allowed')
out.parent.mkdir(parents=True, exist_ok=True)
command = [claude_bin,'-p','--safe-mode','--tools','','--no-chrome','--no-session-persistence','--output-format','json']
started = time.time()
proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        text=True, cwd=brief.parent)
try:
    raw, err = proc.communicate(brief.read_text(), timeout=a.timeout)
except subprocess.TimeoutExpired:
    proc.terminate()
    try: raw,err=proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill();raw,err=proc.communicate()
    p.exit(124,'TIMEOUT: check the current process/result before retrying; no fallback was started.\n')
try:
    result = json.loads(raw)
except ValueError:
    p.exit(1,'BLOCKED: Claude did not return parseable JSON; no fallback was started.\n')
meta = {'host':os.uname().nodename, 'started_unix':started, 'duration_seconds':round(time.time()-started,2),
        'exit_code':proc.returncode,'is_error':result.get('is_error'), 'terminal_reason':result.get('terminal_reason'),
        'auth_route':'claude.ai subscription', 'models':list(result.get('modelUsage',{})),
        'session_id':result.get('session_id'), 'session_persisted':False, 'permission_denials':result.get('permission_denials',[]),
        'tools_enabled':[], 'brief':str(brief), 'result':str(out), 'business_acceptance':'pending Codex verification'}
out.with_suffix(out.suffix+'.meta.json').write_text(json.dumps(meta,indent=2,ensure_ascii=False)+'\n')
out.write_text(result.get('result','')+'\n')
print(json.dumps(meta,ensure_ascii=False))
if proc.returncode or result.get('is_error') or not result.get('result'):
    p.exit(1,'BLOCKED: review the returned error. Auth, quota and network failures require different recovery.\n')

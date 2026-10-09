#!/usr/bin/env python3
"""Deterministic upstream merge discovery and separately credentialed publication.

No candidate scripts, hooks, custom merge drivers, models or automatic merging.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

STABLE = re.compile(r'^v(\d+)\.(\d+)\.(\d+)$')
SHA = re.compile(r'^[0-9a-f]{40}$')
UPSTREAM = 'https://github.com/can1357/oh-my-pi.git'


def git(*args, cwd=None, check=True):
    env = {key: value for key, value in os.environ.items() if key not in ('GITHUB_TOKEN', 'GH_TOKEN') and not key.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
    result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', *args], cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise RuntimeError(result.stderr[:4000])
    return result


def json_request(request):
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status == 204:
            return None
        content = response.read(8 * 1024 * 1024 + 1)
        if len(content) > 8 * 1024 * 1024:
            raise ValueError('API response exceeds bound')
        return json.loads(content)


def api(path, data=None, method=None):
    request = urllib.request.Request('https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + path,
        data=None if data is None else json.dumps(data).encode(), method=method,
        headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'], 'Accept': 'application/vnd.github+json'})
    return json_request(request)


def upstream_releases():
    result = []
    for page in range(1, 101):
        request = urllib.request.Request(f'https://api.github.com/repos/can1357/oh-my-pi/releases?per_page=100&page={page}',
            headers={'User-Agent': 'omp-deterministic-catchup', 'Accept': 'application/vnd.github+json'})
        rows = json_request(request)
        result.extend(row for row in rows if not row['draft'] and not row['prerelease'] and STABLE.fullmatch(row['tag_name']))
        if len(rows) < 100:
            return result
    raise ValueError('upstream release inventory exceeds bound')


OWNERSHIP = 'OMP-CATCHUP-OWNERSHIP-V1\n'


def ownership(pr):
    if pr['user']['login'] != 'github-actions[bot]' or pr['user'].get('type') != 'Bot' or pr['head']['repo']['full_name'] != os.environ['GITHUB_REPOSITORY']:
        return None
    records = []
    for page in range(1, 11):
        rows = api(f'/issues/{pr["number"]}/comments?per_page=100&page={page}')
        for row in rows:
            body = row.get('body', '')
            if row['user']['login'] == 'github-actions[bot]' and row['user'].get('type') == 'Bot' and body.startswith(OWNERSHIP) and len(body) <= 16384:
                try:
                    value = json.loads(body[len(OWNERSHIP):])
                except ValueError:
                    continue
                if set(value) == {'schema', 'tag', 'base', 'candidate', 'upstream_commit', 'tag_object', 'conflicts'} and value['schema'] == 1 and STABLE.fullmatch(value['tag']) and all(isinstance(value[field], str) and SHA.fullmatch(value[field]) for field in ['base', 'candidate', 'upstream_commit', 'tag_object']):
                    records.append(value)
        if len(rows) < 100:
            break
    else:
        raise ValueError('ownership comment inventory exceeds bound')
    if not records:
        return None
    record = records[-1]
    if record['candidate'] != pr['head']['sha'] or pr['head']['ref'] != 'feat/catchup-' + record['tag']:
        return None
    return record



def save_receipt(out, receipt):
    content = json.dumps(receipt, sort_keys=True, separators=(',', ':')) + '\n'
    if len(content.encode()) > 65536:
        raise ValueError('receipt exceeds 64KiB')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'receipt.json').write_text(content)


def pulls(state):
    result = []
    for page in range(1, 101):
        rows = api(f'/pulls?state={state}&base=integration&per_page=100&page={page}')
        result.extend(rows)
        if len(rows) < 100:
            return result
    raise ValueError('PR inventory exceeds bound')


def remote_tags(url):
    return {ref: sha for sha, ref in (line.split() for line in git('ls-remote', '--tags', url).stdout.splitlines())}


def discovery(out, requested):
    repository = os.environ['GITHUB_REPOSITORY']
    fork = 'https://github.com/' + repository + '.git'
    observed = remote_tags(fork)
    upstream = remote_tags(UPSTREAM)
    for ref, sha in observed.items():
        if ref in upstream and upstream[ref] != sha:
            raise ValueError('moved/conflicting authentic upstream tag: ' + ref)
    tags = [ref.removeprefix('refs/tags/') for ref in upstream if STABLE.fullmatch(ref.removeprefix('refs/tags/'))]
    if requested and (not STABLE.fullmatch(requested) or requested not in tags):
        raise ValueError('explicit tag must be authentic stable upstream tag')
    if not tags:
        raise ValueError('no stable upstream tags')
    releases = [release['tag_name'] for release in upstream_releases() if release['tag_name'] in tags] if not requested else []
    if not requested and not releases:
        raise ValueError('no authentic stable published release')
    tag = requested or max(releases, key=lambda value: tuple(map(int, STABLE.fullmatch(value).groups())))
    active = [pr for pr in pulls('open') if pr['head']['ref'].startswith('feat/catchup-')]
    previous = None
    active_pr = None
    if active:
        if len(active) != 1 or not (previous := ownership(active[0])) or previous['conflicts']:
            print('Human-required active catchup remains visible: ' + ', '.join(pr['html_url'] for pr in active))
            return
        active_pr = active[0]
        if requested and requested != previous['tag']:
            print('One active catchup retained; explicit different tag cannot replace it')
            return
        tag = previous['tag']
        tag_ref = 'refs/tags/' + tag
        if upstream.get(tag_ref) != previous['tag_object'] or upstream.get(tag_ref + '^{}', upstream.get(tag_ref)) != previous['upstream_commit'] or observed.get(tag_ref) != previous['tag_object']:
            raise ValueError('existing bot ownership authentic tag identity changed')
        current = api('/git/ref/heads/integration')['object']['sha']
        if current == previous['base']:
            print('Identical bot proposal reused: ' + active_pr['html_url'])
            return
    if not active_pr and not requested and any(pr['head']['ref'] == 'feat/catchup-' + tag and not pr['merged_at'] for pr in pulls('closed')):
        print('Closed unmerged proposal requires explicit manual tag reconsideration')
        return
    out.mkdir(parents=True, exist_ok=True)
    workspace = out / 'repo'
    git('clone', '--no-checkout', fork, str(workspace))
    base = git('rev-parse', 'refs/remotes/origin/integration', cwd=workspace).stdout.strip()
    ref = 'refs/tags/' + tag
    git('fetch', '--no-tags', UPSTREAM, ref + ':refs/audit/upstream', cwd=workspace)
    object_sha = git('rev-parse', 'refs/audit/upstream', cwd=workspace).stdout.strip()
    commit = git('rev-parse', 'refs/audit/upstream^{commit}', cwd=workspace).stdout.strip()
    if object_sha != upstream[ref] or commit != upstream.get(ref + '^{}', upstream[ref]):
        raise ValueError('upstream changed during discovery')
    if previous and (object_sha != previous['tag_object'] or commit != previous['upstream_commit']):
        raise ValueError('bot refresh must retain original authentic upstream identity')
    if git('merge-base', '--is-ancestor', commit, base, cwd=workspace, check=False).returncode == 0:
        print('Latest stable source already integrated; package delivery pending independent evidence')
        return
    git('checkout', '--detach', base, cwd=workspace)
    # No global/system config or local merge-driver commands are admitted.
    # Unknown attribute driver names fall back to Git's ordinary text merger.
    git('config', 'core.attributesFile', '/dev/null', cwd=workspace)
    git('config', 'user.name', 'OMP deterministic catchup', cwd=workspace)
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com', cwd=workspace)
    result = git('merge', '--no-ff', '--no-edit', commit, cwd=workspace, check=False)
    conflicts = []
    if result.returncode:
        conflicts = git('diff', '--name-only', '--diff-filter=U', cwd=workspace).stdout.splitlines()
        if not conflicts:
            raise RuntimeError('merge failed without ordinary conflicts: ' + result.stderr[:2000])
        git('merge', '--abort', cwd=workspace)
        candidate = commit
    else:
        candidate = git('rev-parse', 'HEAD', cwd=workspace).stdout.strip()
        if git('show', '-s', '--format=%P', candidate, cwd=workspace).stdout.strip().split() != [base, commit]:
            raise ValueError('merge did not retain pinned exact parents')
    git('update-ref', 'refs/audit/candidate', candidate, cwd=workspace)
    bundle = out / 'candidate.bundle'
    git('bundle', 'create', str(bundle.resolve()), 'refs/audit/candidate', 'refs/audit/upstream', cwd=workspace)
    with bundle.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    receipt = {'schema': 1, 'repository': repository, 'base': base, 'tag': tag, 'tag_object': object_sha, 'upstream_commit': commit, 'candidate': candidate, 'conflicts': conflicts, 'bundle_sha256': digest, 'refresh': None if previous is None else {'number': active_pr['number'], 'previous': previous}}
    save_receipt(out, receipt)


def publish(out, requested):
    content = (out / 'receipt.json').read_bytes()
    if len(content) > 65536:
        raise ValueError('oversized receipt')
    receipt = json.loads(content)
    if set(receipt) != {'schema', 'repository', 'base', 'tag', 'tag_object', 'upstream_commit', 'candidate', 'conflicts', 'bundle_sha256', 'refresh'} or receipt['schema'] != 1 or receipt['repository'] != os.environ['GITHUB_REPOSITORY']:
        raise ValueError('invalid receipt schema/repository')
    for field in ['base', 'tag_object', 'upstream_commit', 'candidate']:
        if not SHA.fullmatch(receipt[field]):
            raise ValueError('invalid pinned object identity')
    if not STABLE.fullmatch(receipt['tag']) or (requested and requested != receipt['tag']):
        raise ValueError('invalid receipt tag')
    if not isinstance(receipt['conflicts'], list) or any(not isinstance(path, str) or len(path) > 4096 for path in receipt['conflicts']):
        raise ValueError('invalid conflict paths')
    bundle = out / 'candidate.bundle'
    with bundle.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if digest != receipt['bundle_sha256']:
        raise ValueError('bundle digest mismatch')
    fork = 'https://github.com/' + receipt['repository'] + '.git'
    branch = 'feat/catchup-' + receipt['tag']
    active = [pr for pr in pulls('open') if pr['head']['ref'].startswith('feat/catchup-')]
    refresh = receipt['refresh']
    active_pr = None
    if active:
        if not isinstance(refresh, dict) or set(refresh) != {'number', 'previous'} or len(active) != 1 or active[0]['number'] != refresh['number'] or ownership(active[0]) != refresh['previous'] or refresh['previous']['conflicts'] or refresh['previous']['tag'] != receipt['tag']:
            print('Active migrated/human/edited proposal retained; no overwrite')
            return
        active_pr = active[0]
    elif refresh is not None:
        raise ValueError('refresh proposal no longer active')
    if not active_pr and not requested and any(pr['head']['ref'] == branch and not pr['merged_at'] for pr in pulls('closed')):
        print('Closed proposal not automatically recreated')
        return
    current = api('/git/ref/heads/integration')['object']['sha']
    if current != receipt['base']:
        raise ValueError('integration advanced; rediscover rather than publish stale candidate')
    upstream = remote_tags(UPSTREAM)
    ref = 'refs/tags/' + receipt['tag']
    if upstream.get(ref) != receipt['tag_object'] or upstream.get(ref + '^{}', upstream.get(ref)) != receipt['upstream_commit']:
        raise ValueError('authentic upstream tag moved')
    observed = remote_tags(fork)
    if ref in observed and observed[ref] != receipt['tag_object']:
        raise ValueError('refusing to rewrite conflicting fork tag')
    workspace = out / 'writer'
    git('init', str(workspace))
    git('bundle', 'verify', str(bundle.resolve()), cwd=workspace)
    git('-c', 'protocol.file.allow=always', 'fetch', str(bundle.resolve()), 'refs/audit/candidate:refs/audit/candidate', 'refs/audit/upstream:refs/audit/upstream', cwd=workspace)
    if git('rev-parse', 'refs/audit/upstream', cwd=workspace).stdout.strip() != receipt['tag_object'] or git('rev-parse', 'refs/audit/upstream^{commit}', cwd=workspace).stdout.strip() != receipt['upstream_commit']:
        raise ValueError('bundle tag object mismatch')
    if git('rev-parse', 'refs/audit/candidate', cwd=workspace).stdout.strip() != receipt['candidate']:
        raise ValueError('bundle candidate mismatch')
    if receipt['conflicts']:
        if receipt['candidate'] != receipt['upstream_commit']:
            raise ValueError('conflicted proposal must use exact upstream commit')
    elif git('show', '-s', '--format=%P', receipt['candidate'], cwd=workspace).stdout.strip().split() != [receipt['base'], receipt['upstream_commit']]:
        raise ValueError('clean candidate parents mismatch')
    existing = git('ls-remote', '--heads', fork, 'refs/heads/' + branch).stdout.split()
    if active_pr:
        if not existing or existing[0] != refresh['previous']['candidate']:
            raise ValueError('bot candidate changed; human edits cannot be overwritten')
        git('fetch', '--no-tags', fork, 'refs/heads/' + branch + ':refs/audit/prior', cwd=workspace)
        if git('rev-parse', 'refs/audit/prior', cwd=workspace).stdout.strip() != refresh['previous']['candidate']:
            raise ValueError('bot proposal changed during validation')
        old_parents = git('show', '-s', '--format=%P', refresh['previous']['candidate'], cwd=workspace).stdout.strip().split()
        if old_parents != [refresh['previous']['base'], refresh['previous']['upstream_commit']]:
            raise ValueError('prior bot candidate exact parents mismatch')
    elif existing and existing[0] != receipt['candidate']:
        raise ValueError('existing migrated/human branch cannot be rewritten')
    # Credential only reaches this trusted git process, never candidate checkout/code.
    header = 'AUTHORIZATION: basic ' + __import__('base64').b64encode(('x-access-token:' + os.environ['GITHUB_TOKEN']).encode()).decode()
    env = dict(os.environ, GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0=header, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
    refspecs = ['refs/audit/candidate:refs/heads/' + branch]
    if ref not in observed:
        refspecs.append('refs/audit/upstream:' + ref)
    lease = ['--force-with-lease=refs/heads/' + branch + ':' + refresh['previous']['candidate']] if active_pr else []
    subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'push', '--atomic', *lease, fork, *refspecs], cwd=workspace, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    body = 'Deterministic proposal. Human review and protected merge required.\n\nPinned integration: `' + receipt['base'] + '`\nAuthentic upstream tag object: `' + receipt['tag_object'] + '`\nUpstream commit: `' + receipt['upstream_commit'] + '`\nCandidate: `' + receipt['candidate'] + '`\n\nSource not merged; package delivery pending independent signed evidence.'
    if receipt['conflicts']:
        body += '\n\nBlocked: recreate a merge from pinned integration, resolve conflicts, and push human-reviewed work. Recorded conflict paths:\n' + '\n'.join('- `' + path.replace('`', '\\`') + '`' for path in receipt['conflicts'])
    if active_pr:
        pr = api('/pulls/' + str(active_pr['number']), {'body': body}, method='PATCH')
        if receipt['conflicts'] and not pr['draft']:
            request = urllib.request.Request('https://api.github.com/graphql', data=json.dumps({'query': 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}', 'variables': {'id': pr['node_id']}}).encode(), headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'], 'Accept': 'application/vnd.github+json'})
            result = json_request(request)
            if result.get('errors') or not result['data']['convertPullRequestToDraft']['pullRequest']['isDraft']:
                raise ValueError('failed to mark conflicted bot refresh human-required draft')
    else:
        pr = api('/pulls', {'title': 'Catch up to ' + receipt['tag'], 'head': branch, 'base': 'integration', 'body': body, 'draft': bool(receipt['conflicts'])})
    if pr['head']['sha'] != receipt['candidate']:
        raise ValueError('created/refreshed PR exact head mismatch')
    record = {field: receipt[field] for field in ['schema', 'tag', 'base', 'candidate', 'upstream_commit', 'tag_object', 'conflicts']}
    api('/issues/' + str(pr['number']) + '/comments', {'body': OWNERSHIP + json.dumps(record, sort_keys=True, separators=(',', ':'))})
    print(pr['html_url'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['discover', 'publish', 'delivery'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tag', default='')
    args = parser.parse_args()
    if args.tag and not STABLE.fullmatch(args.tag):
        raise ValueError('tag must match stable vMAJOR.MINOR.PATCH grammar')
    if args.mode == 'delivery':
        import package_delivery
        current = api('/git/ref/heads/integration')['object']['sha']
        merged = [pr for pr in pulls('closed') if pr['head']['ref'].startswith('feat/catchup-') and pr['merged_at']]
        latest = max(merged, key=lambda pr: pr['merged_at']) if merged else None
        expected = latest['merge_commit_sha'] if latest else current
        if expected != current:
            print(json.dumps({'state': 'superseded', 'catchup_source': expected, 'current_integration': current, 'pr': latest['html_url']}))
        try:
            evidence = package_delivery.observe(args.output.resolve(), current, Path(__file__).resolve().parent.parent / 'ci/package-signing-key.asc')
        except __import__('urllib.error').error.HTTPError as error:
            if error.code != 404:
                raise
            evidence = {'state': 'pending', 'expected_source': current, 'reason': 'signed package catalog/assets not published'}
        print(json.dumps(evidence, sort_keys=True))
    else:
        (discovery if args.mode == 'discover' else publish)(args.output.resolve(), args.tag)


if __name__ == '__main__':
    main()

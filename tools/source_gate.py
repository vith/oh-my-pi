#!/usr/bin/env python3
"""Trusted integration control only; never import or execute candidate code."""
import argparse
import json
import os
import re
import urllib.request


def api(path, data=None):
    request = urllib.request.Request('https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def identity(number):
    base = api('/git/ref/heads/integration')['object']['sha']
    if number:
        pr = api('/pulls/' + number)
        if pr['state'] != 'open' or pr['base']['ref'] != 'integration' or pr['base']['repo']['full_name'] != os.environ['GITHUB_REPOSITORY']:
            raise ValueError('PR is not an open integration proposal')
        return {'number': number, 'head': pr['head']['sha'], 'base': base}
    return {'number': '', 'head': base, 'base': base}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['prepare', 'status'])
    parser.add_argument('--number', default='')
    parser.add_argument('--head')
    parser.add_argument('--base')
    parser.add_argument('--context', choices=['fork-ci', 'source-review'])
    parser.add_argument('--state', choices=['pending', 'success', 'failure'])
    args = parser.parse_args()
    if args.number and not re.fullmatch(r'[1-9][0-9]{0,8}', args.number):
        raise ValueError('invalid numeric PR number')
    pinned = identity(args.number)
    if args.mode == 'prepare':
        if not args.number and pinned['head'] != os.environ['GITHUB_SHA']:
            raise ValueError('integration push superseded')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            for key, value in pinned.items():
                output.write(f'{key}={value}\n')
        if args.number:
            for context in ['fork-ci', 'source-review']:
                api('/statuses/' + pinned['head'], {'state': 'pending', 'context': context, 'description': 'Pinned current head/base; awaiting validation and human approval'})
    else:
        if pinned['head'] != args.head or pinned['base'] != args.base:
            raise ValueError('head/base changed; old evidence unusable')
        if not args.number:
            return
        api('/statuses/' + args.head, {'state': args.state, 'context': args.context,
            'description': 'Exact head and current integration base verified',
            'target_url': os.environ['GITHUB_SERVER_URL'] + '/' + os.environ['GITHUB_REPOSITORY'] + '/actions/runs/' + os.environ['GITHUB_RUN_ID']})


if __name__ == '__main__':
    main()

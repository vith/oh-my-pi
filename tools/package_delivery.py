#!/usr/bin/env python3
"""Read-only signed package evidence; never approve or roll back source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

FINGERPRINT = 'C557EA3489AC5820B7C019A9D9CFD8271E0C3DD3'
REPOSITORY = 'vith/arch-packages'
ORIGIN = 'https://github.com/vith/arch-packages/releases/latest/download'


def fetch(url, path, maximum=1024 * 1024 * 1024):
    request = urllib.request.Request(url, headers={'User-Agent': 'omp-read-only-delivery-observer'})
    with urllib.request.urlopen(request, timeout=60) as response, path.open('wb') as output:
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > maximum:
                raise ValueError('download exceeds bound')
            output.write(chunk)


def release_url(url, snapshot, filename):
    expected = 'https://github.com/' + REPOSITORY + '/releases/download/' + urllib.parse.quote(snapshot, safe='') + '/' + urllib.parse.quote(filename, safe='')
    if url != expected or not re.fullmatch(r'[A-Za-z0-9_.+-]+', filename):
        raise ValueError('catalog destination outside exact package release identity')
    return url


def verify(directory, signature, data):
    subprocess.run(['gpgv', '--homedir', str(directory / 'gnupg'), '--keyring', str(directory / 'keyring.gpg'), str(signature), str(data)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def asset(directory, catalog, filename):
    entry = catalog['files'][filename]
    if not re.fullmatch(r'[0-9a-f]{64}', entry['sha256']):
        raise ValueError('invalid signed file digest')
    path = directory / filename
    fetch(release_url(entry['url'], catalog['snapshot'], filename), path)
    with path.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if digest != entry['sha256']:
        raise ValueError('signed catalog file digest mismatch')
    return path


def observe(directory, expected, key):
    directory.mkdir(parents=True, exist_ok=True)
    home = directory / 'gnupg'
    home.mkdir(mode=0o700, exist_ok=True)
    os.chmod(home, 0o700)
    listing = subprocess.run(['gpg', '--homedir', str(home), '--with-colons', '--show-keys', str(key)], capture_output=True, text=True, check=True).stdout
    primary = [line.split(':')[9] for line in listing.splitlines() if line.startswith('fpr:')]
    if not primary or primary[0] != FINGERPRINT:
        raise ValueError('committed dedicated key fingerprint mismatch')
    subprocess.run(['gpg', '--homedir', str(home), '--batch', '--yes', '--dearmor', '--output', str(directory / 'keyring.gpg'), str(key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    catalog_path = directory / 'catalog.json'
    fetch(ORIGIN + '/catalog.json', catalog_path, 8 * 1024 * 1024)
    signature = directory / 'catalog.json.sig'
    fetch(ORIGIN + '/catalog.json.sig', signature, 65536)
    verify(directory, signature, catalog_path)
    catalog = json.loads(catalog_path.read_bytes())
    if catalog['schema'] != 1 or catalog['repository'] != REPOSITORY or catalog['key_fingerprint'] != FINGERPRINT:
        raise ValueError('catalog authority mismatch')
    recipe = catalog['recipes']['oh-my-pi-vith-git']
    source = next(source for source in recipe['sources'] if source['kind'] == 'git' and source['id'] == 'omp-git')
    if source['commit'] != expected:
        return {'state': 'pending', 'expected_source': expected, 'active_package_source': source['commit'], 'snapshot': catalog['snapshot']}
    database = asset(directory, catalog, 'n3t-arch.db')
    db_signature = asset(directory, catalog, 'n3t-arch.db.sig')
    verify(directory, db_signature, database)
    members = subprocess.run(['bsdtar', '-tf', str(database)], check=True, capture_output=True, text=True).stdout.splitlines()
    descs = [path for path in members if path.endswith('/desc') and path.startswith('oh-my-pi-vith-git-')]
    if len(descs) != 1:
        raise ValueError('database OMP entry ambiguous/missing')
    description = subprocess.run(['bsdtar', '-xOf', str(database), descs[0]], check=True, capture_output=True, text=True).stdout
    values = {}
    for block in description.split('\n\n'):
        lines = block.strip().splitlines()
        if lines and lines[0].startswith('%'):
            if lines[0] in values:
                raise ValueError('duplicate database identity')
            values[lines[0]] = lines[1:]
    filename = values['%FILENAME%'][0]
    package = asset(directory, catalog, filename)
    package_signature = asset(directory, catalog, filename + '.sig')
    verify(directory, package_signature, package)
    if values['%NAME%'] != ['oh-my-pi-vith-git'] or values['%VERSION%'] != [recipe['version']] or values['%SHA256SUM%'] != [catalog['files'][filename]['sha256']]:
        raise ValueError('database/catalog package identity mismatch')
    accepted = catalog['accepted_sha']
    if not re.fullmatch(r'[0-9a-f]{40}', accepted):
        raise ValueError('invalid accepted recipe head')
    request = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY + '/actions/runs?head_sha=' + accepted + '&status=success&per_page=100', headers={'User-Agent': 'omp-delivery-observer', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        runs = json.load(response)['workflow_runs']
    return {'state': 'published', 'source': expected, 'snapshot': catalog['snapshot'], 'input_digest': recipe['input_digest'], 'version': recipe['version'], 'package_sha256': catalog['files'][filename]['sha256'], 'fingerprint': FINGERPRINT, 'actions': [run['html_url'] for run in runs if run['head_sha'] == accepted], 'catalog': ORIGIN + '/catalog.json'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--key', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.source):
        raise ValueError('invalid expected source SHA')
    try:
        evidence = observe(args.directory.resolve(), args.source, args.key.resolve())
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        evidence = {'state': 'pending', 'expected_source': args.source, 'reason': 'signed package catalog/assets not published'}
    print(json.dumps(evidence, sort_keys=True))


if __name__ == '__main__':
    main()

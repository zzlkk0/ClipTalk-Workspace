#!/usr/bin/env python3
"""Diagnose whether this machine can reach a ClipTalk site (Python 3.6+, standard library).

Steps: DNS, TCP, TLS, /api/health, key authentication, project read, and
optionally one test message (--write-test) that you delete afterwards in the
web page. It only reports; it never tries proxies, tunnels or other ways around
network restrictions. The key is never printed.

  CLIPTALK_URL=https://example.org CLIPTALK_TOKEN_FILE=~/.config/cliptalk/token \\
    python3 scripts/check-connectivity.py --project fyp [--write-test] [--json]
"""
import argparse
import datetime
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LOCAL_HOSTS = ('127.0.0.1', 'localhost', '::1')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'redirect refused (%s)' % newurl.split('?')[0], headers, fp)


def main():
    parser = argparse.ArgumentParser(description='ClipTalk connectivity check')
    parser.add_argument('--project', help='project ID to test reading (and writing with --write-test)')
    parser.add_argument('--write-test', action='store_true', help='post one test message to USER; delete it in the web page afterwards')
    parser.add_argument('--timeout', type=float, default=10)
    parser.add_argument('--json', action='store_true', help='print a JSON summary at the end')
    args = parser.parse_args()
    steps = []

    def record(name, ok, detail):
        steps.append({'step': name, 'ok': ok, 'detail': detail})
        sys.stdout.write('[%s] %-8s %s\n' % ('OK' if ok else ('SKIP' if ok is None else 'FAIL'), name, detail))
        sys.stdout.flush()
        return ok

    def finish():
        if args.json:
            sys.stdout.write(json.dumps({'checked_at': datetime.datetime.utcnow().isoformat() + 'Z', 'python': sys.version.split()[0], 'steps': steps}, indent=2) + '\n')
        return 0 if all(step['ok'] is not False for step in steps) else 1

    url = os.environ.get('CLIPTALK_URL', '')
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.path not in ('', '/') or parts.username:
        record('config', False, 'Set CLIPTALK_URL to a site origin such as https://example.org')
        return finish()
    if parts.scheme == 'http' and parts.hostname not in LOCAL_HOSTS:
        record('config', False, 'Remote plaintext HTTP is not supported; use HTTPS or an SSH tunnel to localhost')
        return finish()
    proxies = [name for name in ('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY') if os.environ.get(name)]
    record('config', True, '%s (Python %s)%s' % (parts.scheme + '://' + parts.netloc, sys.version.split()[0],
                                                 '; proxy variables set but not used: ' + ', '.join(proxies) if proxies else ''))
    host, port = parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80)

    try:
        addresses = sorted(set(info[4][0] for info in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)))
        record('dns', True, '%s -> %s' % (host, ', '.join(addresses[:4])))
    except socket.gaierror as error:
        record('dns', False, '%s: %s' % (host, error))
        return finish()

    started = time.time()
    try:
        connection = socket.create_connection((host, port), timeout=args.timeout)
        record('tcp', True, 'port %d reachable in %d ms' % (port, (time.time() - started) * 1000))
    except (socket.timeout, OSError) as error:
        record('tcp', False, 'port %d: %s (a firewall or network policy may block it; ask the network administrator)' % (port, error))
        return finish()

    context = ssl.create_default_context(cafile=os.environ.get('CLIPTALK_CA_FILE') or None)
    if parts.scheme == 'https':
        try:
            with context.wrap_socket(connection, server_hostname=host) as tls:
                cert = tls.getpeercert()
                record('tls', True, '%s, certificate valid until %s' % (tls.version(), cert.get('notAfter', '?')))
        except (ssl.SSLError, OSError) as error:
            record('tls', False, '%s (if the site uses a private CA, set CLIPTALK_CA_FILE)' % error)
            return finish()
    else:
        connection.close()
        record('tls', None, 'not used for localhost HTTP')

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=context))
    base = parts.scheme + '://' + parts.netloc

    def call(path, method='GET', body=None, token=None):
        request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode('utf-8'), method=method)
        request.add_header('User-Agent', 'cliptalk-connectivity-check')
        if body is not None:
            request.add_header('Content-Type', 'application/json')
        if token:
            request.add_header('Authorization', 'Bearer ' + token)
        try:
            response = opener.open(request, timeout=args.timeout)
            return response.getcode(), json.loads(response.read().decode('utf-8') or 'null')
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read().decode('utf-8'))
            except Exception:
                return error.code, {'error': str(error.reason)}

    try:
        status, health = call('/api/health')
    except Exception as error:
        record('health', False, str(error))
        return finish()
    if status != 200:
        record('health', False, 'HTTP %d' % status)
        return finish()
    features = health.get('features') or []
    record('health', 'projects' in features, 'release %s, features %s%s' % (health.get('release'), features, '' if 'projects' in features else ' (project module missing: update the site)'))

    token = ''
    try:
        if os.environ.get('CLIPTALK_TOKEN_FILE'):
            with open(os.path.expanduser(os.environ['CLIPTALK_TOKEN_FILE'])) as handle:
                token = handle.read().strip()
        else:
            token = os.environ.get('CLIPTALK_TOKEN', '').strip()
    except (IOError, OSError) as error:
        record('auth', False, 'cannot read CLIPTALK_TOKEN_FILE: %s' % error.strerror)
        return finish()
    if not re.match(r'^ct_[A-Za-z0-9_-]{43}$', token):
        record('auth', False, 'set CLIPTALK_TOKEN_FILE to a file containing the ct_ key')
        return finish()
    status, me = call('/api/v1/me', token=token)
    if status != 200:
        record('auth', False, 'HTTP %d %s' % (status, me.get('error')))
        return finish()
    record('auth', bool(me.get('actor')), 'key "%s", actor %s, scopes %s%s' % (me.get('keyName'), me.get('actor'), ', '.join(me.get('scopes', [])),
                                                                             '' if me.get('actor') else ' (no actor: the key can only read projects)'))

    if not args.project:
        record('project', None, 'skipped (pass --project ID)')
        return finish()
    status, state = call('/api/v1/projects/%s/state' % urllib.parse.quote(args.project, safe=''), token=token)
    if status != 200:
        record('read', False, 'HTTP %d %s' % (status, state.get('error')))
        return finish()
    record('read', True, 'project %s: %d statuses, %d open decisions, event cursor %s' % (args.project, len(state.get('statuses', {})), state.get('open_decisions', 0), state.get('cursor')))

    if not args.write_test:
        record('write', None, 'skipped (pass --write-test to post one test message)')
        return finish()
    body = {'to': 'USER', 'type': 'info', 'body': 'Connectivity check from %s at %s UTC. Safe to delete in the web page.' % (me.get('actor'), datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M'))}
    status, message = call('/api/v1/projects/%s/messages' % urllib.parse.quote(args.project, safe=''), 'POST', body, token)
    record('write', status == 201, 'test message %s posted; delete it on the Messages tab' % message.get('id') if status == 201 else 'HTTP %d %s' % (status, message.get('error')))
    return finish()


if __name__ == '__main__':
    sys.exit(main())

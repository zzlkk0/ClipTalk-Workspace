#!/usr/bin/env python3
"""Copy an old native installation's complete data into the registered one.

Python 3.6+; standard library only. The source is retained, the destination is
backed up while stopped, and failed startups restore the original destination.
"""
import argparse
import grp
import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote
from urllib.request import ProxyHandler, build_opener

SERVICE = 'cliptalk-workspace.service'
ACCOUNT_COLUMNS = 'id,username,password_hash,role,status,language,created_at'


def read_accounts(data):
    database = data / 'database/users.db'
    if not database.is_file() or database.stat().st_size == 0:
        raise RuntimeError('The source account database is missing or empty.')
    connection = sqlite3.connect('file:' + quote(str(database)) + '?mode=ro', uri=True)
    try:
        if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('Account database integrity check failed.')
        rows = connection.execute('SELECT ' + ACCOUNT_COLUMNS + ' FROM users ORDER BY id').fetchall()
    finally:
        connection.close()
    if not any(row[3] == 'admin' and row[4] == 'active' for row in rows):
        raise RuntimeError('The source must contain an existing active administrator.')
    return {row[0]: row for row in rows}


def read_config(data):
    with (data / 'config.json').open() as source:
        config = json.load(source)
    if not isinstance(config, dict) or not config.get('sessionSecret'):
        raise RuntimeError('The source configuration must contain its existing session secret.')
    return config


def plain_tree(data):
    """Refuse links and special files; copying must stay inside this directory."""
    if data.is_symlink() or not data.is_dir():
        raise RuntimeError('Each data directory must be a real directory.')
    size = 0
    for directory, folders, files in os.walk(str(data)):
        for name in folders + files:
            info = (Path(directory) / name).lstat()
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise RuntimeError('Data directories cannot contain symlinks or special files.')
            if stat.S_ISREG(info.st_mode):
                size += info.st_size
    return size


def ensure_unused(*directories):
    prefixes = tuple(str(directory) + '/' for directory in directories)
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            descriptors = list((process / 'fd').iterdir())
        except (OSError, PermissionError):
            continue
        for descriptor in descriptors:
            try:
                filename = os.readlink(str(descriptor))
            except OSError:
                continue
            if filename.startswith(prefixes):
                raise RuntimeError('Data is still open by process ' + process.name +
                                   '; stop its application before migrating.')


def write_json(filename, value):
    with filename.open('w') as destination:
        json.dump(value, destination, ensure_ascii=False, indent=2)
        destination.write('\n')
    os.chmod(str(filename), 0o600)


def set_owner(data, uid, gid):
    for directory, folders, files in os.walk(str(data)):
        for name in folders + files:
            os.chown(str(Path(directory) / name), uid, gid)
    os.chown(str(data), uid, gid)


def wait_for_health(port):
    # Respect the server's own configuration, not a shell's HTTP proxy.
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with opener.open('http://127.0.0.1:' + str(port) + '/api/health', timeout=2) as response:
                if json.load(response).get('ok') is True:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError('The migrated application did not pass its startup health check.')


class NativeService:
    def __init__(self, target):
        result = subprocess.check_output(
            ['systemctl', 'show', SERVICE, '-p', 'User', '-p', 'Group',
             '-p', 'WorkingDirectory', '-p', 'Environment'], universal_newlines=True)
        properties = dict(line.split('=', 1) for line in result.splitlines() if '=' in line)
        environment = dict(item.split('=', 1) for item in shlex.split(properties.get('Environment', '')) if '=' in item)
        if (properties.get('WorkingDirectory') != str(target / 'current') or
                environment.get('CLIPTALK_DATA_DIR') != str(target / 'data') or
                environment.get('CLIPTALK_CONFIG', str(target / 'data/config.json')) != str(target / 'data/config.json')):
            raise RuntimeError('The registered native service must already use the --to directory.')
        user = properties.get('User', '')
        account = pwd.getpwuid(int(user)) if user.isdigit() else pwd.getpwnam(user)
        if account.pw_uid == 0:
            raise RuntimeError('The native service must use an unprivileged service account.')
        group = properties.get('Group')
        self.uid = account.pw_uid
        self.gid = (int(group) if group.isdigit() else grp.getgrnam(group).gr_gid) if group else account.pw_gid

    def stop(self):
        subprocess.check_call(['systemctl', 'stop', SERVICE])

    def restart(self):
        subprocess.check_call(['systemctl', 'restart', SERVICE])


def migrate(source, target, service, port=None, healthcheck=wait_for_health):
    if (source == target or source in target.parents or target in source.parents):
        raise RuntimeError('Choose separate, non-overlapping source and destination installations.')
    source_data, target_data = source / 'data', target / 'data'
    source_size = plain_tree(source_data)
    plain_tree(target_data)
    # Validate before stopping the working destination or allocating backups.
    read_accounts(source_data)
    read_accounts(target_data)
    read_config(source_data)
    current_config = read_config(target_data)
    selected_port = current_config.get('port', 8000) if port is None else port
    if type(selected_port) is not int or not 1 <= selected_port <= 65535:
        raise RuntimeError('Choose a port between 1 and 65535.')
    if shutil.disk_usage(str(target)).free < source_size * 2 + 16 * 1024 * 1024:
        raise RuntimeError('Insufficient disk space for the source backup and staged data.')
    backups = target / 'backups'
    if backups.is_symlink():
        raise RuntimeError('The backup directory cannot be a symlink.')
    backups.mkdir(mode=0o700, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%SZ-', time.gmtime()) + 'migration-', dir=str(backups)))
    stage = Path(tempfile.mkdtemp(prefix='.migration-stage-', dir=str(target)))
    old_port = (target / '.port').read_bytes() if (target / '.port').exists() else None
    stopped, swapped = False, False
    try:
        print('Stopping the destination service and saving both data directories...', flush=True)
        stopped = True
        service.stop()
        ensure_unused(source_data, target_data)
        expected = read_accounts(source_data)
        # Retain the full source snapshot, including every SQLite WAL/SHM file,
        # upload, archive and configuration. The source installation is untouched.
        shutil.copytree(str(source_data), str(backup / 'source-data'))
        shutil.copytree(str(backup / 'source-data'), str(stage / 'data'))
        staged = stage / 'data'
        if read_accounts(staged) != expected:
            raise RuntimeError('The staged account database differs from the source.')
        config = read_config(staged)
        config['port'] = selected_port
        write_json(staged / 'config.json', config)
        set_owner(staged, service.uid, service.gid)
        # Atomic renames keep the original destination intact for rollback.
        target_data.rename(backup / 'previous-data')
        swapped = True
        staged.rename(target_data)
        print('Starting the destination with the original accounts and data...', flush=True)
        service.restart()
        healthcheck(selected_port)
        actual = read_accounts(target_data)
        if any(actual.get(identifier) != row for identifier, row in expected.items()):
            raise RuntimeError('Existing account identities or passwords changed during startup.')
        (target / '.port').write_text(str(selected_port) + '\n')
        write_json(backup / 'migration.json', {
            'source': str(source), 'destination': str(target), 'port': selected_port,
            'existing_accounts': len(expected), 'completed': True,
        })
        print('Migration complete: ' + str(len(expected)) + ' existing accounts retained; port ' + str(selected_port) + '.', flush=True)
        print('Data directory: ' + str(target_data))
        print('Backups: ' + str(backup))
        print('Original source retained: ' + str(source_data))
        print('Sign in with your original account names and passwords.')
        return backup
    except BaseException:
        if stopped:
            try:
                service.stop()
                if swapped:
                    if target_data.exists():
                        target_data.rename(backup / 'failed-data')
                    (backup / 'previous-data').rename(target_data)
                    if old_port is None:
                        if (target / '.port').exists():
                            (target / '.port').unlink()
                    else:
                        (target / '.port').write_bytes(old_port)
                service.restart()
                print('Migration failed; the previous destination service and data were restored.', file=sys.stderr)
            except Exception as rollback_error:
                print('Automatic rollback could not finish: ' + str(rollback_error) +
                      '. Original destination data: ' + str(backup / 'previous-data'), file=sys.stderr)
        raise
    finally:
        shutil.rmtree(str(stage))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from', dest='source', required=True, help='Old installation root, containing data/')
    parser.add_argument('--to', dest='target', required=True, help='Registered destination installation root')
    parser.add_argument('--port', type=int, help='Destination port; defaults to its current configured port')
    arguments = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('Run this native migration as root on the Linux server.')
    if not Path(arguments.source).is_absolute() or not Path(arguments.target).is_absolute():
        parser.error('Use absolute installation paths.')
    os.umask(0o077)
    try:
        source, target = Path(arguments.source).resolve(), Path(arguments.target).resolve()
        if not (target / 'current/server.js').is_file():
            raise RuntimeError('The destination must already have a native application release.')
        if (target / '.deployment-mode').read_text().strip() != 'native':
            raise RuntimeError('This helper supports native installations only.')
        migrate(source, target, NativeService(target), arguments.port)
    except Exception as error:
        print('Migration stopped: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

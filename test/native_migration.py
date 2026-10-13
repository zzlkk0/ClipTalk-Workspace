"""Isolated filesystem/SQLite tests; no host service commands are executed."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'migration', str(Path(__file__).resolve().parents[1] / 'scripts/migrate-native-data.py'))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class ServiceFixture:
    uid, gid = os.getuid(), os.getgid()

    def __init__(self):
        self.events = []

    def stop(self):
        self.events.append('stop')

    def restart(self):
        self.events.append('restart')


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cliptalk-migration-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source, self.target = self.root / 'original', self.root / 'installed'
        self.service = ServiceFixture()
        self.make_data(self.source, ['original-admin', 'original-member'], 18000)
        self.make_data(self.target, ['replacement-admin'], 19000)
        (self.target / '.port').write_text('19000\n')
        self.before_source = self.contents(self.source / 'data')
        self.before_target = self.contents(self.target / 'data')

    def make_data(self, installation, names, port):
        data = installation / 'data'
        (data / 'database').mkdir(parents=True)
        (data / 'uploads').mkdir()
        database = sqlite3.connect(str(data / 'database/users.db'))
        database.execute('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT, status TEXT, language TEXT, created_at INTEGER)')
        for i, name in enumerate(names):
            database.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?)',
                             (name, name, 'fixture-hash-' + name,
                              'admin' if i == 0 else 'user', 'active', 'en', 123456))
        database.commit()
        database.close()
        workspace = sqlite3.connect(str(data / 'database/workspace.db'))
        workspace.execute('CREATE TABLE retained (archive TEXT, quota INTEGER, owner TEXT)')
        workspace.execute('INSERT INTO retained VALUES (?,?,?)', ('named archive', 2**30, names[0]))
        workspace.commit()
        workspace.close()
        (data / 'config.json').write_text(json.dumps({'port': port, 'sessionSecret': names[0] + '-secret'}))
        (data / 'uploads/document.txt').write_text(names[0] + ' complete file contents')
        (data / 'history.json').write_text('{"messages":[]}')

    def contents(self, directory):
        return {str(item.relative_to(directory)): item.read_bytes()
                for item in directory.rglob('*') if item.is_file()}

    def run_migration(self, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return migration.migrate(self.source, self.target, self.service, **kwargs)

    def test_full_data_and_old_password_records_restored_with_both_backups(self):
        accounts = migration.read_accounts(self.source / 'data')
        checked = []
        backup = self.run_migration(healthcheck=lambda port: checked.append(port))
        self.assertEqual(checked, [19000])
        self.assertEqual(migration.read_accounts(self.target / 'data'), accounts)
        self.assertEqual(self.contents(self.source / 'data'), self.before_source)
        self.assertEqual(self.contents(backup / 'source-data'), self.before_source)
        self.assertEqual(self.contents(backup / 'previous-data'), self.before_target)
        restored = self.contents(self.target / 'data')
        for name, content in self.before_source.items():
            if name != 'config.json':
                self.assertEqual(restored[name], content)
        config = migration.read_config(self.target / 'data')
        self.assertEqual(config['sessionSecret'], 'original-admin-secret')
        self.assertEqual(config['port'], 19000)
        self.assertEqual(self.service.events, ['stop', 'restart'])
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.target / 'data/config.json').stat().st_mode & 0o777, 0o600)

    def test_failed_health_restores_entire_destination_and_saved_port(self):
        def failed(port):
            self.assertEqual(port, 20000)
            raise RuntimeError('forced startup failure')
        with self.assertRaisesRegex(RuntimeError, 'forced startup failure'):
            self.run_migration(port=20000, healthcheck=failed)
        self.assertEqual(self.contents(self.target / 'data'), self.before_target)
        self.assertEqual(self.contents(self.source / 'data'), self.before_source)
        self.assertEqual((self.target / '.port').read_text(), '19000\n')
        self.assertEqual(self.service.events, ['stop', 'restart', 'stop', 'restart'])
        self.assertTrue(list((self.target / 'backups').glob('*/failed-data/database/users.db')))

    def test_changed_password_during_startup_rolls_back(self):
        def change_password(port):
            connection = sqlite3.connect(str(self.target / 'data/database/users.db'))
            connection.execute("UPDATE users SET password_hash='changed' WHERE role='admin'")
            connection.commit()
            connection.close()
        with self.assertRaisesRegex(RuntimeError, 'identities or passwords changed'):
            self.run_migration(healthcheck=change_password)
        self.assertEqual(self.contents(self.target / 'data'), self.before_target)

    def test_missing_original_accounts_aborts_without_stopping_destination(self):
        (self.source / 'data/database/users.db').unlink()
        with self.assertRaisesRegex(RuntimeError, 'missing or empty'):
            self.run_migration()
        self.assertEqual(self.service.events, [])
        self.assertEqual(self.contents(self.target / 'data'), self.before_target)
        self.assertFalse((self.target / 'backups').exists())

    def test_still_open_data_aborts_and_restarts_existing_destination(self):
        with (self.source / 'data/uploads/document.txt').open() as held_open:
            self.assertTrue(held_open.read())
            with self.assertRaisesRegex(RuntimeError, 'still open by process'):
                self.run_migration()
        self.assertEqual(self.service.events, ['stop', 'stop', 'restart'])
        self.assertEqual(self.contents(self.source / 'data'), self.before_source)
        self.assertEqual(self.contents(self.target / 'data'), self.before_target)

    def test_linked_files_or_overlapping_installations_abort_without_mutation(self):
        (self.source / 'data/uploads/link').symlink_to(self.target / 'data/config.json')
        with self.assertRaisesRegex(RuntimeError, 'symlinks or special files'):
            self.run_migration()
        self.assertEqual(self.service.events, [])
        with self.assertRaisesRegex(RuntimeError, 'non-overlapping'):
            migration.migrate(self.source, self.source, self.service)


if __name__ == '__main__':
    unittest.main(verbosity=2)

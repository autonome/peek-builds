"""Exercise the real hidden-input script with a controlling pseudo-terminal.

Uses synthetic tokens and temporary home directories only; no network calls.
"""
import errno
import os
from pathlib import Path
import pty
import select
import signal
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name('store-peek-ci-token.sh').resolve()
TOKEN = 'github_pat_synthetic_fixture_only_123456'


def run_in_terminal(home, response=TOKEN):
    pid, master = pty.fork()
    if pid == 0:
        os.environ['HOME'] = str(home)
        os.execv('/bin/bash', ['bash', '-x', str(SCRIPT)])
    output = bytearray()
    sent = False
    reaped = False
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if not ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output.extend(chunk)
            if not sent and b'GitHub token (hidden): ' in output:
                os.write(master, (response + '\n').encode())
                sent = True
        else:
            raise AssertionError('Script did not finish within timeout')
        _, status = os.waitpid(pid, 0)
        reaped = True
        return os.waitstatus_to_exitcode(status), output.decode(errors='replace')
    finally:
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(master)


class TokenStorageTests(unittest.TestCase):
    def test_real_terminal_saves_without_echo_even_with_xtrace(self):
        with tempfile.TemporaryDirectory() as home:
            code, output = run_in_terminal(home)
            self.assertEqual(code, 0, output)
            self.assertNotIn(TOKEN, output)
            target = Path(home) / '.config/peek-ci/github-token'
            self.assertEqual(target.read_text(), TOKEN)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)

    def test_existing_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as home:
            target = Path(home) / '.config/peek-ci/github-token'
            target.parent.mkdir(parents=True)
            target.write_text('existing-fixture')
            code, output = run_in_terminal(home)
            self.assertNotEqual(code, 0)
            self.assertIn('already exists', output)
            self.assertEqual(target.read_text(), 'existing-fixture')
            self.assertNotIn('GitHub token (hidden): ', output)

    def test_invalid_input_creates_no_file_and_is_not_echoed(self):
        with tempfile.TemporaryDirectory() as home:
            response = 'invalid_synthetic_secret'
            code, output = run_in_terminal(home, response)
            self.assertNotEqual(code, 0)
            self.assertNotIn(response, output)
            self.assertFalse((Path(home) / '.config/peek-ci/github-token').exists())

    def test_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as home:
            target = Path(home) / '.config/peek-ci/github-token'
            target.parent.mkdir(parents=True)
            other = Path(home) / 'must-not-change'
            other.write_text('untouched')
            target.symlink_to(other)
            code, output = run_in_terminal(home)
            self.assertNotEqual(code, 0)
            self.assertIn('already exists', output)
            self.assertEqual(other.read_text(), 'untouched')


if __name__ == '__main__':
    unittest.main()

#!/bin/bash
# Store the repo-scoped setup token locally; never upload it or alter gh login.
set +x +v
set -euo pipefail
umask 077

if [[ $# -ne 0 ]]; then
  printf 'Usage: %s\nRun on the machine where the coding agent needs GitHub access.\n' "$0" >&2
  exit 1
fi

python3 - <<'PY'
import getpass
import os
from pathlib import Path
import re
import stat
import sys
import warnings

folder = Path.home() / '.config' / 'peek-ci'
target = folder / 'github-token'
fd = None
created = False
success = False
try:
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = folder.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('Token directory must be an owned, non-symlink directory.')
    os.chmod(folder, 0o700)
    # Refuse overwrite, including dangling symlinks. The user must explicitly
    # remove an obsolete token before replacing it.
    if os.path.lexists(target):
        raise ValueError('Token file already exists. Remove it explicitly before replacing it.')
    # This stream is output-only. Buffered r+ streams require seeking when
    # switching direction, which a terminal cannot support. getpass opens its
    # own controlling-terminal input and disables echo there.
    with open('/dev/tty', 'w') as terminal:
        terminal.write('Use a fine-grained token restricted to autonome/peek-builds.\n')
        terminal.flush()
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            token = getpass.getpass('GitHub token (hidden): ', stream=terminal)
    if not re.fullmatch(r'github_pat_[A-Za-z0-9_]+', token) or len(token) > 1000:
        raise ValueError('Expected a fine-grained personal access token (github_pat_...).')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    created = True
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        fd = None
        output.write(token)
        output.flush()
        os.fsync(output.fileno())
    token = None
    success = True
    print(f'Saved with mode 600: {target}')
    print('No network request was made; normal gh login was not changed.')
except (KeyboardInterrupt, EOFError):
    print('\nCancelled; no token saved.', file=sys.stderr)
    sys.exit(1)
except ValueError as error:
    print(f'Error: {error}', file=sys.stderr)
    sys.exit(1)
except getpass.GetPassWarning:
    print('Error: hidden terminal input is unavailable; no token saved.', file=sys.stderr)
    sys.exit(1)
except OSError:
    print('Error: could not securely read or save the token. Check local permissions and terminal access.', file=sys.stderr)
    sys.exit(1)
finally:
    if fd is not None:
        os.close(fd)
    if created and not success:
        target.unlink(missing_ok=True)
PY

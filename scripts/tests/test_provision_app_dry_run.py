from __future__ import annotations

import subprocess
from pathlib import Path


def test_provision_app_dry_run_includes_scaffold_path_without_env_requirements():
    repo_root = Path(__file__).resolve().parent.parent.parent

    result = subprocess.run(
        [
            'node',
            'scripts/provision-app.mjs',
            '--app',
            'smoke-lane',
            '--worker-name',
            'smoke-lane',
            '--db',
            'shared:factory-shared',
            '--domain',
            'none',
            '--rate-limiter-id',
            '1099',
            '--scaffold',
            '--recipe',
            'outbound-dialer',
            '--dry-run',
        ],
        cwd=repo_root,
        capture_output=True,
        text=True,
        errors='replace',
    )

    assert result.returncode == 0, f'Script failed: {result.stderr}\n{result.stdout}'
    assert 'ERROR: Required environment variable not set' not in result.stdout
    assert '[DRY-RUN] node' in result.stdout
    assert '--recipe outbound-dialer' in result.stdout
    assert '--no-secrets' in result.stdout
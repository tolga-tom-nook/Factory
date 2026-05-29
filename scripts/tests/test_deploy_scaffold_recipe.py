from __future__ import annotations

import os
import stat
import shutil
import subprocess
from pathlib import Path

import pytest


def _remove_readonly(func, path, exc_info):
    os.chmod(path, stat.S_IWRITE)
    func(path)


@pytest.mark.skipif(shutil.which('wrangler') is None, reason="wrangler not in PATH")
def test_deploy_scaffold_recipe_generates_app(tmp_path: Path):
    repo_root = Path(__file__).resolve().parent.parent.parent
    app_dir = repo_root / 'outbound-dialer-app-ci'
    if app_dir.exists():
        shutil.rmtree(app_dir, onerror=_remove_readonly)

    result = subprocess.run(
        [
            'node',
            'packages/deploy/scripts/scaffold.mjs',
            'outbound-dialer-app-ci',
            '--recipe',
            'outbound-dialer',
            '--no-install',
            '--no-secrets',
            '--no-deploy',
            '--no-prereq',
            '--hyperdrive-id',
            'REPLACE_WITH_HYPERDRIVE_ID',
        ],
        cwd=repo_root,
        capture_output=True,
        text=True,
        errors='replace',
    )

    try:
        assert result.returncode == 0, f'Script failed: {result.stderr}\n{result.stdout}'
        assert app_dir.exists(), 'Scaffold app directory was not created'
        package_json = (app_dir / 'package.json').read_text(encoding='utf-8')
        assert '@latimer-woods-tech/telephony' in package_json
        assert '@latimer-woods-tech/compliance' in package_json

        dev_vars = (app_dir / '.dev.vars.example').read_text(encoding='utf-8')
        assert 'ANTHROPIC_API_KEY=' in dev_vars
        assert 'TELNYX_API_KEY=' in dev_vars

        index_ts = (app_dir / 'src' / 'index.ts').read_text(encoding='utf-8')
        assert "app.get('/manifest'" in index_ts
        assert "app.post('/api/campaigns/:id/start'" in index_ts

        ci_text = (app_dir / '.github' / 'workflows' / 'ci.yml').read_text(encoding='utf-8')
        deploy_text = (app_dir / '.github' / 'workflows' / 'deploy.yml').read_text(encoding='utf-8')
        assert 'uses: Latimer-Woods-Tech/factory/.github/workflows/_app-ci.yml@main' in ci_text
        assert 'uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy.yml@main' in deploy_text
        assert 'https://outbound-dialer-app-ci.latwoodtech.work/health' in deploy_text
    finally:
        if app_dir.exists():
            shutil.rmtree(app_dir, onerror=_remove_readonly)

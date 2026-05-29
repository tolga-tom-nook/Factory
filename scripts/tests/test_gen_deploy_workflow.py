from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def _remove_readonly(func, path, exc_info):
    import os
    import stat

    os.chmod(path, stat.S_IWRITE)
    func(path)


def test_gen_deploy_workflow_creates_workflows(tmp_path: Path):
    repo_root = Path(__file__).resolve().parent.parent.parent
    output_dir = tmp_path / 'generated-app'
    output_dir.mkdir()

    result = subprocess.run(
        [
            'node',
            'scripts/gen-deploy-workflow.mjs',
            '--recipe',
            'outbound-dialer',
            '--app-name',
            'outbound-dialer-app',
            '--output',
            str(output_dir),
        ],
        cwd=repo_root,
        capture_output=True,
        text=True,
        errors='replace',
    )

    assert result.returncode == 0, f'Script failed: {result.stderr}\n{result.stdout}'
    ci_file = output_dir / '.github' / 'workflows' / 'ci.yml'
    deploy_file = output_dir / '.github' / 'workflows' / 'deploy.yml'
    assert ci_file.exists(), 'CI workflow was not created'
    assert deploy_file.exists(), 'Deploy workflow was not created'

    ci_text = ci_file.read_text(encoding='utf-8')
    deploy_text = deploy_file.read_text(encoding='utf-8')
    assert 'uses: Latimer-Woods-Tech/factory/.github/workflows/_app-ci.yml@main' in ci_text
    assert 'uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy.yml@main' in deploy_text
    assert 'health_url:' in deploy_text
    assert 'https://outbound-dialer-app.latwoodtech.work/health' in deploy_text

    shutil.rmtree(output_dir, onerror=_remove_readonly)

import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';

interface AppLifecycleEntry {
  id: string;
  name: string;
  repo: string;
  stage: 'provisioned' | 'scaffolded' | 'deployed' | 'live';
  health_url: string | null;
  custom_domain: string | null;
  provisioned_at: string | null;
  deployed_at: string | null;
  live_at: string | null;
  notes: string | null;
}

interface AppLifecycleState {
  generatedAt: string;
  apps: AppLifecycleEntry[];
}

const STAGE_CLASS: Record<string, string> = {
  provisioned: 'bg-slate-700 text-slate-200',
  scaffolded:  'bg-yellow-900/60 text-yellow-200',
  deployed:    'bg-blue-900/60 text-blue-200',
  live:        'bg-green-900/60 text-green-200',
};

const GITHUB_REPO_BASE = 'https://github.com/latimer-woods-tech';

function StageBadge({ stage }: { stage: string }) {
  const cls = STAGE_CLASS[stage] ?? 'bg-slate-700 text-slate-200';
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {stage}
    </span>
  );
}

function AppRow({ app }: { app: AppLifecycleEntry }) {
  return (
    <tr className="border-b border-border transition-colors hover:bg-muted/10">
      <td className="whitespace-nowrap py-2.5 pl-4 pr-3 text-sm font-mono text-slate-400">
        {app.id}
      </td>
      <td className="py-2.5 pr-4 text-sm">
        <a
          href={`${GITHUB_REPO_BASE}/${app.repo}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-100 hover:text-blue-400 hover:underline"
        >
          {app.name}
        </a>
        {app.notes && (
          <p className="mt-0.5 text-xs text-slate-500">{app.notes}</p>
        )}
      </td>
      <td className="whitespace-nowrap py-2.5 pr-4">
        <StageBadge stage={app.stage} />
      </td>
      <td className="whitespace-nowrap py-2.5 pr-4 text-sm text-slate-400">
        {app.health_url ? (
          <a
            href={app.health_url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-blue-400 hover:underline"
          >
            {app.custom_domain ?? app.health_url.replace('https://', '').replace('/health', '')}
          </a>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="whitespace-nowrap py-2.5 pr-4 text-sm text-slate-400">
        {app.live_at ?? app.deployed_at ?? app.provisioned_at ?? '—'}
      </td>
    </tr>
  );
}

export function AppsTab() {
  const [state, setState] = useState<AppLifecycleState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadState = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/app-lifecycle.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} loading app-lifecycle.json`);
      const data = (await res.json()) as AppLifecycleState;
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const liveApps = state?.apps.filter((a) => a.stage === 'live') ?? [];
  const inProgressApps = state?.apps.filter((a) => a.stage !== 'live') ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">App Lifecycle</h2>
          <p className="text-sm text-slate-400">
            Deployment stage and health status for all Factory applications.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadState()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-800/60 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {state && (
        <>
          {/* Summary badges */}
          <div className="flex flex-wrap gap-3 text-sm">
            {(['live', 'deployed', 'scaffolded', 'provisioned'] as const).map((stage) => {
              const count = state.apps.filter((a) => a.stage === stage).length;
              return (
                <div key={stage} className="flex items-center gap-1.5">
                  <StageBadge stage={stage} />
                  <span className="text-slate-400">{count}</span>
                </div>
              );
            })}
          </div>

          {/* Live apps */}
          {liveApps.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Live ({liveApps.length})
              </h3>
              <div className="overflow-hidden rounded-md border border-border">
                <table className="w-full text-left">
                  <thead className="border-b border-border bg-muted/20">
                    <tr>
                      <th className="py-2.5 pl-4 pr-3 text-xs font-medium uppercase tracking-wide text-slate-500">ID</th>
                      <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-slate-500">Name</th>
                      <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-slate-500">Stage</th>
                      <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-slate-500">Domain / Health</th>
                      <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-slate-500">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveApps.map((app) => (
                      <AppRow key={app.id} app={app} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* In-progress apps */}
          {inProgressApps.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                In Progress ({inProgressApps.length})
              </h3>
              <div className="overflow-hidden rounded-md border border-border">
                <table className="w-full text-left">
                  <thead className="border-b border-border bg-muted/20">
                    <tr>
                      <th className="py-2.5 pl-4 pr-3 text-xs font-medium uppercase tracking-wide text-slate-500">ID</th>
                      <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-slate-500">Name</th>
                      <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-slate-500">Stage</th>
                      <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-slate-500">Domain / Health</th>
                      <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-slate-500">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inProgressApps.map((app) => (
                      <AppRow key={app.id} app={app} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="text-xs text-slate-600">
            Data from{' '}
            <a
              href="https://github.com/latimer-woods-tech/factory/blob/main/docs/app-lifecycle.yml"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-slate-400 hover:underline"
            >
              docs/app-lifecycle.yml
            </a>{' '}
            · Generated {new Date(state.generatedAt).toLocaleDateString()}
          </p>
        </>
      )}
    </div>
  );
}

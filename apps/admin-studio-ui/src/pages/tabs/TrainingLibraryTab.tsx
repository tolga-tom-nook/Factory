import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.js';
import { Button } from '../../components/ui/button.js';

interface TrainingLibraryModule {
  briefKey: string;
  composition: 'MarketingVideo' | 'TrainingVideo' | 'WalkthroughVideo';
  audience: string;
  area: string;
  status: string;
  topic: string;
}

interface TrainingLibraryResponse {
  appId: string;
  library: string;
  version: number;
  updatedAt: string;
  description: string;
  modules: TrainingLibraryModule[];
}

const APPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'prime_self', label: 'Prime Self (selfprime.net)' },
  { id: 'capricast', label: 'Capricast' },
  { id: 'xico_city', label: 'DJMEXXICO / xico-city' },
  { id: 'the_calling', label: 'The Calling' },
  { id: 'ijustus', label: 'iJustus / Kairos Council' },
];

export function TrainingLibraryTab() {
  const [appId, setAppId] = useState('prime_self');
  const [library, setLibrary] = useState<TrainingLibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadLibrary = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      // schedule-worker (proxied via admin-studio) wraps the manifest as { data: … }.
      const result = await apiFetch<{ data: TrainingLibraryResponse }>(`/training-library?appId=${appId}`);
      setLibrary(result.data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  async function scheduleModule(briefKey: string) {
    setError(null);
    setSuccess(null);
    setScheduling(briefKey);
    try {
      await apiFetch('/jobs/from-brief', {
        method: 'POST',
        body: JSON.stringify({ appId, briefKey, triggerSource: 'manual' }),
      });
      setSuccess(`Scheduled render for ${briefKey}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScheduling(null);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h1 className="text-2xl font-semibold text-white">Training Library</h1>
          <select
            value={appId}
            onChange={(e) => { setAppId(e.target.value); setLibrary(null); }}
            className="rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 min-h-[2.5rem]"
          >
            {APPS.map(a => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </div>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            View Prime Self training modules and schedule video renders for ready briefs.
            Ready modules can be sent directly to the render pipeline from here.
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded border border-red-700 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {success ? (
        <div className="rounded border border-emerald-700 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
          {success}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded border border-slate-700 bg-slate-900 px-4 py-6 text-sm text-slate-300">
          Loading training library...
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-slate-800 bg-slate-900">
          <table className="min-w-full border-collapse text-sm text-slate-200">
            <thead className="bg-slate-950/60 text-left text-slate-400">
              <tr>
                <th className="px-4 py-3">Topic</th>
                <th className="px-4 py-3">Composition</th>
                <th className="px-4 py-3">Audience</th>
                <th className="px-4 py-3">Area</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {library?.modules.map((module) => (
                <tr key={module.briefKey} className="border-t border-slate-800">
                  <td className="px-4 py-3 text-slate-100">
                    <div className="font-medium">{module.topic}</div>
                    <div className="text-xs text-slate-500">{module.briefKey}</div>
                  </td>
                  <td className="px-4 py-3">{module.composition}</td>
                  <td className="px-4 py-3">{module.audience}</td>
                  <td className="px-4 py-3">{module.area}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                      module.status === 'ready'
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : module.status === 'planned'
                        ? 'bg-amber-500/10 text-amber-300'
                        : 'bg-slate-700/30 text-slate-300'
                    }`}>
                      {module.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {module.status === 'ready' ? (
                      <Button
                        size="sm"
                        disabled={scheduling === module.briefKey}
                        onClick={() => void scheduleModule(module.briefKey)}
                      >
                        {scheduling === module.briefKey ? 'Scheduling…' : 'Schedule'}
                      </Button>
                    ) : (
                      <span className="text-slate-500">Unavailable</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

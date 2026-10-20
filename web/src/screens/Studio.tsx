import { useCallback, useEffect, useState } from 'react';
import { api, type Portrait, type Style } from '../api';
import { CreateForm } from '../components/CreateForm';
import { PortraitCard } from '../components/PortraitCard';

const POLL_MS = 2000;

export function Studio() {
  const [styles, setStyles] = useState<Style[]>([]);
  const [portraits, setPortraits] = useState<Portrait[]>([]);

  const refresh = useCallback(async () => {
    setPortraits((await api.portraits()).portraits);
  }, []);

  useEffect(() => {
    api.styles().then((r) => setStyles(r.styles));
    refresh();
  }, [refresh]);

  // Poll only while something is still in progress.
  const pending = portraits.some((p) => p.status === 'queued' || p.status === 'running');
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [pending, refresh]);

  return (
    <div className="studio">
      <CreateForm styles={styles} onCreated={(p) => setPortraits((list) => [p, ...list])} />
      <section>
        <h2>Your portraits</h2>
        {portraits.length === 0 ? (
          <p className="muted">Nothing yet — your first portrait will appear here.</p>
        ) : (
          <div className="grid">
            {portraits.map((p) => (
              <PortraitCard key={p.id} portrait={p} styleLabel={styles.find((s) => s.id === p.style)?.label ?? p.style} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

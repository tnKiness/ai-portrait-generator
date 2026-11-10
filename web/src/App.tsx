import { useEffect, useState } from 'react';
import { api, DEMO_MODE, type User } from './api';
import { SignIn } from './screens/SignIn';
import { Studio } from './screens/Studio';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          Portrait&nbsp;Studio{DEMO_MODE && <small className="demo-badge">Browser demo · no server or AI</small>}
        </span>
        {user && (
          <button className="link" onClick={logout}>
            Sign out
          </button>
        )}
      </header>
      <main>
        {user === undefined ? <p className="muted center">Loading…</p> : user ? <Studio /> : <SignIn onSignedIn={setUser} />}
      </main>
    </div>
  );
}

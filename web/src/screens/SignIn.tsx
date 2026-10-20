import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type User } from '../api';

export function SignIn({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      if (err instanceof ApiError && err.retryAfter) setCooldown(err.retryAfter);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    return run(async () => {
      await api.requestOtp(phone);
      setStep('code');
      setCooldown(60);
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => onSignedIn((await api.verifyOtp(phone, code)).user));
  };

  return (
    <section className="card narrow">
      <h1>Turn a photo into a portrait</h1>
      <p className="muted">Sign in with your phone number to start.</p>

      {step === 'phone' ? (
        <form onSubmit={sendCode}>
          <label>
            Phone number
            <input
              type="tel" inputMode="tel" autoComplete="tel" placeholder="0912 345 678"
              value={phone} onChange={(e) => setPhone(e.target.value)} required
            />
          </label>
          <button disabled={busy || cooldown > 0}>{cooldown > 0 ? `Wait ${cooldown}s` : 'Send code'}</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <label>
            6-digit code sent to {phone}
            <input
              inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus
            />
          </label>
          <button disabled={busy || code.length !== 6}>Verify</button>
          <div className="row">
            <button type="button" className="link" onClick={() => setStep('phone')}>Change number</button>
            <button type="button" className="link" disabled={cooldown > 0} onClick={() => sendCode()}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </button>
          </div>
          <p className="hint">Local demo: the code is printed in the API server's console.</p>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

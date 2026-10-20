import { useEffect, useState, type FormEvent } from 'react';
import { api, type Portrait, type Style } from '../api';

const MAX_BYTES = 10 * 1024 * 1024;

export function CreateForm({ styles, onCreated }: { styles: Style[]; onCreated: (p: Portrait) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [style, setStyle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!style && styles[0]) setStyle(styles[0].id);
  }, [styles, style]);

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (f: File | undefined) => {
    setError(null);
    if (f && f.size > MAX_BYTES) {
      setError('Photo must be 10 MB or smaller');
      return setFile(null);
    }
    setFile(f ?? null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('name', name.trim());
      form.set('style', style);
      form.set('photo', file);
      onCreated((await api.createPortrait(form)).portrait);
      setFile(null);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>New portrait</h2>
      <label className="drop">
        {preview ? <img src={preview} alt="Selected photo" /> : <span>Choose a photo (JPEG, PNG or WebP)</span>}
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      <label>
        Name on the portrait
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required />
      </label>
      <fieldset>
        <legend>Style</legend>
        <div className="chips">
          {styles.map((s) => (
            <label key={s.id} className={s.id === style ? 'chip active' : 'chip'}>
              <input type="radio" name="style" value={s.id} checked={s.id === style} onChange={() => setStyle(s.id)} />
              {s.label}
            </label>
          ))}
        </div>
      </fieldset>
      <button disabled={busy || !file || !name.trim()}>{busy ? 'Uploading…' : 'Create portrait'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

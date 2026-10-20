import type { Portrait } from '../api';

const STATUS_TEXT: Record<Portrait['status'], string> = {
  queued: 'Waiting in queue…',
  running: 'Painting…',
  succeeded: 'Ready',
  failed: 'Failed',
};

export function PortraitCard({ portrait, styleLabel }: { portrait: Portrait; styleLabel: string }) {
  const { status, imageUrl, name, error } = portrait;
  return (
    <figure className={`portrait ${status}`}>
      {imageUrl ? (
        <a href={imageUrl} target="_blank" rel="noreferrer">
          <img src={imageUrl} alt={`Portrait of ${name}`} loading="lazy" />
        </a>
      ) : (
        <div className="placeholder" aria-live="polite">
          {status === 'failed' ? '⚠︎' : <span className="spinner" />}
          <span>{STATUS_TEXT[status]}</span>
        </div>
      )}
      <figcaption>
        <strong>{name}</strong> · {styleLabel}
        {imageUrl && (
          <a className="link" href={imageUrl} download={`portrait-${name}.png`}>Download</a>
        )}
        {error && <p className="error">{error}</p>}
      </figcaption>
    </figure>
  );
}

import { useEffect, useState } from 'react';
import type { PriceLevel } from './PriceChart';

interface SetupTemplate {
  id: string;
  name: string;
  description: string;
  type: 'LONG' | 'SHORT' | 'BOTH';
  lines: string[];
}

type LineKind = PriceLevel['kind'];

const LINE_KINDS: { value: LineKind; label: string }[] = [
  { value: 'support', label: 'Support' },
  { value: 'resistance', label: 'Resistance' },
  { value: 'stop_loss', label: 'Stop Loss' },
  { value: 'take_profit', label: 'Take Profit' },
];

interface Props {
  currentPrice: number | null;
  levels: PriceLevel[];
  onAddLevel: (level: PriceLevel) => void;
  onRemoveLevel: (index: number) => void;
  onClearLevels: () => void;
}

export default function ChartDrawingTools({
  currentPrice,
  levels,
  onAddLevel,
  onRemoveLevel,
  onClearLevels,
}: Props) {
  const [setups, setSetups] = useState<SetupTemplate[]>([]);
  const [kind, setKind] = useState<LineKind>('support');
  const [price, setPrice] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/manual-trade/setups')
      .then((res) => res.json())
      .then((data) => setSetups(data.setups ?? []))
      .catch(() => setSetups([]));
  }, []);

  const addLine = () => {
    const parsed = Number(price);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a valid price');
      return;
    }
    setError(null);
    onAddLevel({ price: parsed, kind, label: label.trim() || undefined });
    setPrice('');
    setLabel('');
  };

  return (
    <div className="rounded-lg border border-bg-border bg-bg-panel p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-ink-faint">Chart levels</h3>
        {levels.length > 0 && (
          <button onClick={onClearLevels} className="text-xs text-ink-faint hover:text-ink">
            Clear all
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as LineKind)}
          className="rounded-md border border-bg-border bg-bg-raised px-2 py-1.5 text-sm text-ink"
        >
          {LINE_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          step="any"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder={currentPrice ? currentPrice.toFixed(2) : 'Price'}
          className="rounded-md border border-bg-border bg-bg-raised px-2 py-1.5 text-sm text-ink"
        />
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="rounded-md border border-bg-border bg-bg-raised px-2 py-1.5 text-sm text-ink"
        />
        <button
          onClick={addLine}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90"
        >
          Add line
        </button>
      </div>

      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}

      {levels.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {levels.map((level, i) => (
            <li
              key={`${level.kind}-${level.price}-${i}`}
              className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-raised px-2 py-1 text-xs text-ink-muted"
            >
              <span className="uppercase tracking-wide text-ink-faint">{level.kind.replace('_', ' ')}</span>
              <span className="text-ink">{level.price}</span>
              {level.label && <span className="text-ink-faint">· {level.label}</span>}
              <button onClick={() => onRemoveLevel(i)} className="text-ink-faint hover:text-ink">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {setups.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-ink-faint">
            Popular setups
          </summary>
          <ul className="mt-2 space-y-2">
            {setups.map((setup) => (
              <li key={setup.id} className="rounded-md border border-bg-border bg-bg-raised p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">{setup.name}</span>
                  <span className="text-ink-faint">{setup.type}</span>
                </div>
                <p className="mt-1 text-ink-muted">{setup.description}</p>
                <p className="mt-1 text-ink-faint">{setup.lines.join(' · ')}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

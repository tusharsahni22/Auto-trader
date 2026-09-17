import { useState } from 'react';
import type { Asset, Trade } from '../lib/types';
import type { PriceLevel } from './PriceChart';

interface Props {
  asset: Asset;
  currentPrice: number | null;
  levels: PriceLevel[];
  onTradeOpened: (trade: Trade) => void;
}

export default function ManualTradeEntry({ asset, currentPrice, levels, onTradeOpened }: Props) {
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [quantity, setQuantity] = useState('');
  const [setupType, setSetupType] = useState('MANUAL');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const entry = Number(entryPrice) || currentPrice || 0;
  const stop = Number(stopLoss);
  const target = Number(takeProfit);
  const risk = entry && stop ? Math.abs(entry - stop) : 0;
  const reward = entry && target ? Math.abs(target - entry) : 0;

  const fillFromLevels = () => {
    const stopLevel = levels.find((l) => l.kind === 'stop_loss');
    const targetLevel = levels.find((l) => l.kind === 'take_profit');
    if (stopLevel) setStopLoss(String(stopLevel.price));
    if (targetLevel) setTakeProfit(String(targetLevel.price));
    if (!entryPrice && currentPrice) setEntryPrice(String(currentPrice));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch('/api/manual-trade/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset,
          direction,
          entryPrice: entryPrice || currentPrice,
          stopLoss,
          takeProfit: takeProfit || undefined,
          quantity,
          setupType,
          notes,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setMessage({ kind: 'ok', text: `Opened ${direction} ${asset} at ${data.trade.entryPrice}` });
        onTradeOpened(data.trade);
        setNotes('');
      } else {
        setMessage({ kind: 'error', text: data.error ?? 'Failed to open trade' });
      }
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the backend' });
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'w-full rounded-md border border-bg-border bg-bg-raised px-2 py-1.5 text-sm text-ink';

  return (
    <form onSubmit={submit} className="rounded-lg border border-bg-border bg-bg-panel p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-ink-faint">Manual entry — {asset}</h3>
        {levels.length > 0 && (
          <button type="button" onClick={fillFromLevels} className="text-xs text-accent hover:opacity-80">
            Use drawn levels
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-ink-faint">
          Direction
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'LONG' | 'SHORT')}
            className={inputClass}
          >
            <option value="LONG">LONG</option>
            <option value="SHORT">SHORT</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-faint">
          Entry {currentPrice ? `(live ${currentPrice.toFixed(2)})` : ''}
          <input
            type="number"
            step="any"
            value={entryPrice}
            onChange={(e) => setEntryPrice(e.target.value)}
            placeholder={currentPrice ? currentPrice.toFixed(2) : ''}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-faint">
          Stop loss
          <input
            type="number"
            step="any"
            required
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-faint">
          Take profit
          <input
            type="number"
            step="any"
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-faint">
          Quantity
          <input
            type="number"
            step="any"
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-faint">
          Setup
          <select value={setupType} onChange={(e) => setSetupType(e.target.value)} className={inputClass}>
            <option value="MANUAL">Manual</option>
            <option value="SUPPORT_BOUNCE">Support bounce</option>
            <option value="RESISTANCE_REJECTION">Resistance rejection</option>
            <option value="BREAKOUT">Breakout</option>
            <option value="BREAKDOWN">Breakdown</option>
            <option value="RANGE_TRADE">Range trade</option>
          </select>
        </label>
      </div>

      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        className={inputClass + ' mt-2'}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-ink-muted">
          {risk > 0 && (
            <>
              Risk <span className="text-ink">{risk.toFixed(2)}</span>
              {reward > 0 && (
                <>
                  {' · '}Reward <span className="text-ink">{reward.toFixed(2)}</span>
                  {' · '}R:R <span className="text-ink">1:{(reward / risk).toFixed(2)}</span>
                </>
              )}
            </>
          )}
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Opening…' : 'Open trade'}
        </button>
      </div>

      {message && (
        <div className={'mt-2 text-xs ' + (message.kind === 'ok' ? 'text-emerald-400' : 'text-red-400')}>
          {message.text}
        </div>
      )}
    </form>
  );
}

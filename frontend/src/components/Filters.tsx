export interface FilterState {
  asset: string;
  status: string;
  direction: string;
}

interface Props {
  value: FilterState;
  onChange: (v: FilterState) => void;
}

const selectCls =
  "rounded-md border border-bg-border bg-bg-raised px-2 py-1.5 text-sm text-ink outline-none focus:border-accent";

export default function Filters({ value, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={selectCls}
        value={value.asset}
        onChange={(e) => onChange({ ...value, asset: e.target.value })}
      >
        <option value="">All assets</option>
        <option value="BTCUSDT">BTC</option>
        <option value="ETHUSDT">ETH</option>
      </select>
      <select
        className={selectCls}
        value={value.direction}
        onChange={(e) => onChange({ ...value, direction: e.target.value })}
      >
        <option value="">Long &amp; Short</option>
        <option value="LONG">Long</option>
        <option value="SHORT">Short</option>
      </select>
      <select
        className={selectCls}
        value={value.status}
        onChange={(e) => onChange({ ...value, status: e.target.value })}
      >
        <option value="">Open &amp; Closed</option>
        <option value="OPEN">Open</option>
        <option value="CLOSED">Closed</option>
      </select>
    </div>
  );
}

export default function QuotaMeter({ status }) {
  if (!status) return null;
  const pct = Math.min(100, Math.round((status.unitsUsedToday / status.autoPauseAtUnits) * 100));
  return (
    <div className="card">
      <h2>Quota — today (resets midnight PT)</h2>
      <div className="meter">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <p>
        {status.unitsUsedToday.toLocaleString()} / {status.autoPauseAtUnits.toLocaleString()} units
        {' '}({pct}%)
      </p>
    </div>
  );
}

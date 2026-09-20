import { useState } from 'react';
import { api } from '../api';

export default function IntervalControl({ status, onChange }) {
  const [minutes, setMinutes] = useState(status?.scanIntervalMinutes || 15);
  const [saving, setSaving] = useState(false);

  const presets = [10, 20, 30, 60];

  async function save(m) {
    setSaving(true);
    setMinutes(m);
    await api.setInterval(m);
    setSaving(false);
    onChange?.();
  }

  return (
    <div className="card">
      <h2>Scan interval</h2>
      <div className="preset-row">
        {presets.map((m) => (
          <button key={m} className={m === minutes ? 'active' : ''} onClick={() => save(m)}>
            {m}m
          </button>
        ))}
        <input
          type="number"
          min="1"
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          onBlur={() => save(minutes)}
        />
      </div>
      {saving && <p className="hint">Saving…</p>}
      <label className="switch-row">
        <input
          type="checkbox"
          checked={status?.botEnabled ?? true}
          onChange={async (e) => {
            await api.setEnabled(e.target.checked);
            onChange?.();
          }}
        />
        Bot enabled
      </label>
    </div>
  );
}

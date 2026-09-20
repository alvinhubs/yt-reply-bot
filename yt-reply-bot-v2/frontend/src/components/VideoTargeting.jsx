import { useState } from 'react';
import { api } from '../api';

export default function VideoTargeting({ videos, onChange }) {
  const [newId, setNewId] = useState('');
  const [busyId, setBusyId] = useState(null);

  async function addVideo() {
    if (!newId.trim()) return;
    await api.addVideo(newId.trim());
    setNewId('');
    onChange?.();
  }

  async function catchUp(videoId) {
    setBusyId(videoId);
    const result = await api.catchUpVideo(videoId);
    setBusyId(null);
    alert(`Scanned ${result.scanned} threads, replied to ${result.enqueued}.`);
    onChange?.();
  }

  return (
    <div className="card">
      <h2>Videos</h2>
      <div className="add-video-row">
        <input
          placeholder="Video ID (e.g. dQw4w9WgXcQ)"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
        />
        <button onClick={addVideo}>Track</button>
        <button onClick={() => api.scanNow().then(() => onChange?.())}>Scan all now</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Replied</th>
            <th>Active</th>
            <th>Last scanned</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {videos.map((v) => (
            <tr key={v.video_id}>
              <td>{v.title || v.video_id}</td>
              <td>{v.replied_count}</td>
              <td>
                <input
                  type="checkbox"
                  checked={v.is_active}
                  onChange={() => api.toggleVideo(v.video_id).then(() => onChange?.())}
                />
              </td>
              <td>{v.last_scanned_at ? new Date(v.last_scanned_at).toLocaleString() : '—'}</td>
              <td>
                <button disabled={busyId === v.video_id} onClick={() => catchUp(v.video_id)}>
                  {busyId === v.video_id ? 'Working…' : 'Catch up'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export const api = {
  getStatus: () => request('/status'),
  setEnabled: (enabled) => request('/settings/enabled', { method: 'POST', body: JSON.stringify({ enabled }) }),
  setInterval: (minutes) => request('/settings/interval', { method: 'POST', body: JSON.stringify({ minutes }) }),
  setAutoPause: (units) => request('/settings/auto-pause', { method: 'POST', body: JSON.stringify({ units }) }),
  getVideos: () => request('/videos'),
  addVideo: (videoId) => request('/videos', { method: 'POST', body: JSON.stringify({ videoId }) }),
  toggleVideo: (videoId) => request(`/videos/${videoId}/toggle`, { method: 'POST' }),
  catchUpVideo: (videoId) => request(`/videos/${videoId}/catch-up`, { method: 'POST' }),
  scanNow: () => request('/scan-now', { method: 'POST' }),
  getRecentReplies: (limit = 50) => request(`/replies/recent?limit=${limit}`),
};

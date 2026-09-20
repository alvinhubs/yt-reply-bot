import { useEffect, useState, useCallback } from 'react';
import { api } from './api';
import QuotaMeter from './components/QuotaMeter';
import IntervalControl from './components/IntervalControl';
import VideoTargeting from './components/VideoTargeting';
import ReplyLog from './components/ReplyLog';

export default function App() {
  const [status, setStatus] = useState(null);
  const [videos, setVideos] = useState([]);

  const refresh = useCallback(() => {
    api.getStatus().then(setStatus);
    api.getVideos().then(setVideos);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="app">
      <h1>yt-reply-bot-v2</h1>
      <div className="grid">
        <QuotaMeter status={status} />
        <IntervalControl status={status} onChange={refresh} />
        <VideoTargeting videos={videos} onChange={refresh} />
        <ReplyLog />
      </div>
    </div>
  );
}

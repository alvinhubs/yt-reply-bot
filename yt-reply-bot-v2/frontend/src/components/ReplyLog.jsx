import { useEffect, useState } from 'react';
import { api } from '../api';

export default function ReplyLog() {
  const [replies, setReplies] = useState([]);

  useEffect(() => {
    api.getRecentReplies().then(setReplies);
    const t = setInterval(() => api.getRecentReplies().then(setReplies), 15000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card">
      <h2>Recent replies</h2>
      <ul className="reply-log">
        {replies.map((r) => (
          <li key={r.thread_id}>
            <div className="comment">{r.original_comment}</div>
            <div className="reply">→ {r.reply_text || '(pre-existing reply, not posted by bot)'}</div>
            <div className="meta">
              {r.source} · {new Date(r.replied_at).toLocaleString()}
            </div>
          </li>
        ))}
        {replies.length === 0 && <li className="hint">No replies yet.</li>}
      </ul>
    </div>
  );
}

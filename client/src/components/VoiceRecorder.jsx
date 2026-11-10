import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { t } from '../i18n.js';

const MAX_MS = 5 * 60e3;
const pickType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((x) => window.MediaRecorder?.isTypeSupported?.(x)) || '';
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Record a voice message; "Add to email" uploads it and gives back { url, durationMs }. */
export default function VoiceRecorder({ onAdd, onClose }) {
  const [state, setState] = useState('idle'); // idle | recording | done | uploading
  const [ms, setMs] = useState(0);
  const [blob, setBlob] = useState(null);
  const [err, setErr] = useState('');
  const rec = useRef(null); const chunks = useRef([]); const started = useRef(0); const timer = useRef(null); const stream = useRef(null);
  const preview = blob ? URL.createObjectURL(blob) : null;
  useEffect(() => () => { clearInterval(timer.current); stream.current?.getTracks().forEach((x) => x.stop()); }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const start = async () => {
    setErr('');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setErr(t('This browser can’t record audio.')); return; }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch { setErr(t('Allow the microphone for this site to record a voice message.')); return; }
    const type = pickType();
    const r = new MediaRecorder(stream.current, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      stream.current?.getTracks().forEach((x) => x.stop());
      setBlob(new Blob(chunks.current, { type: (r.mimeType || type || 'audio/webm').split(';')[0] }));
      setState('done');
    };
    rec.current = r; r.start(500); started.current = Date.now(); setMs(0); setState('recording');
    timer.current = setInterval(() => { const d = Date.now() - started.current; setMs(d); if (d >= MAX_MS) stop(); }, 200);
  };
  const stop = () => { clearInterval(timer.current); setMs(Date.now() - started.current); if (rec.current?.state === 'recording') rec.current.stop(); };
  const add = async () => {
    setState('uploading'); setErr('');
    try {
      const fd = new FormData();
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      fd.append('durationMs', String(Math.round(ms)));
      fd.append('audio', blob, `voice-message.${ext}`);
      const r = await api.form('/api/voice', fd);
      onAdd(r);
    } catch (e) { setErr(e.message); setState('done'); }
  };

  return (
    <div className="voice-rec" role="dialog" aria-label={t('Voice message')}>
      <div className="voice-head"><b>{t('Voice message')}</b><button type="button" className="icon-btn xs" aria-label={t('Close')} onClick={() => { stop(); onClose(); }}><Icon name="close" size={14} /></button></div>
      {state === 'idle' && <button type="button" className="voice-big" onClick={start} aria-label={t('Start recording')}><Icon name="mic" size={28} /></button>}
      {state === 'recording' && <>
        <button type="button" className="voice-big rec" onClick={stop} aria-label={t('Stop recording')}><Icon name="stop" size={24} /></button>
        <div className="voice-time"><span className="voice-dot" /> {fmt(ms)} <span className="muted small">/ {fmt(MAX_MS)}</span></div>
      </>}
      {(state === 'done' || state === 'uploading') && <>
        <audio controls src={preview} className="voice-audio" />
        <div className="actions">
          <button type="button" className="btn primary" disabled={state === 'uploading'} onClick={add}>{state === 'uploading' ? t('Adding…') : t('Add to email')}</button>
          <button type="button" className="btn" disabled={state === 'uploading'} onClick={() => { setBlob(null); setState('idle'); }}>{t('Record again')}</button>
        </div>
      </>}
      {state === 'idle' && <div className="muted small">{t('Tap to record, up to 5 minutes. They’ll get a link to play it — no app needed.')}</div>}
      {err && <div className="form-error small">{err}</div>}
    </div>
  );
}

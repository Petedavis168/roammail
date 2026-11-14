import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { avatarColor, initials } from '../util.js';

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function parseAddresses(text) {
  return text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
    return m ? { name: m[1].replace(/^"|"$/g, '').trim(), address: m[2].trim() } : { name: '', address: s };
  });
}

export default function RecipientInput({ label, value, onChange, autoFocus, right }) {
  const [text, setText] = useState('');
  const [sugg, setSugg] = useState([]);
  const [hi, setHi] = useState(0);
  const timer = useRef();
  const input = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (text.trim().length < 1) return setSugg([]);
    timer.current = setTimeout(() => {
      api.contacts(text.trim()).then((r) => { setSugg(r.filter((c) => !value.some((v) => v.address.toLowerCase() === c.address.toLowerCase()))); setHi(0); }).catch(() => {});
    }, 150);
  }, [text, value]);

  const add = (picked) => {
    const list = picked.flatMap((a) => (a.group ? a.members : [a])); // a contact group adds everyone in it
    const fresh = list.filter((a) => a.address && !value.some((v) => v.address.toLowerCase() === a.address.toLowerCase()));
    if (fresh.length) onChange([...value, ...fresh]);
    setText(''); setSugg([]);
  };
  const commit = () => { if (text.trim()) add(parseAddresses(text)); };

  const onKey = (e) => {
    if (sugg.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault(); setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + sugg.length) % sugg.length); return;
    }
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (sugg.length && text) { e.preventDefault(); add([sugg[hi]]); return; }
      if (text.trim()) { if (e.key !== 'Tab') e.preventDefault(); commit(); }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape') setSugg([]);
  };

  return (
    <div className="rcpt" onClick={() => input.current?.focus()}>
      <span className="rcpt-label">{label}</span>
      <div className="rcpt-chips">
        {value.map((a, i) => (
          <span key={a.address + i} className={`rchip ${EMAIL_RE.test(a.address) ? '' : 'bad'}`} title={a.address}>
            {a.name || a.address}
            <button type="button" onClick={(e) => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)); }} aria-label={`Remove ${a.address}`}>×</button>
          </span>
        ))}
        <input ref={input} value={text} autoFocus={autoFocus} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          onBlur={() => setTimeout(commit, 150)} onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[,;\n]/.test(t)) { e.preventDefault(); add(parseAddresses(t)); } }}
          aria-label={label} />
      </div>
      {right}
      {sugg.length > 0 && (
        <div className="sugg">
          {sugg.map((c, i) => (
            <button type="button" key={c.address} className={i === hi ? 'hi' : ''} onMouseDown={(e) => { e.preventDefault(); add([c]); }}>
              {c.group ? <span className="avatar group-av">👥</span> : <span className="avatar" style={{ background: avatarColor(c.address) }}>{initials(c)}</span>}
              <span><b>{c.name || c.address}</b>{c.group ? <small>{c.members.length} {c.members.length === 1 ? 'person' : 'people'}: {c.members.slice(0, 3).map((m) => m.name || m.address).join(', ')}{c.members.length > 3 ? '…' : ''}</small> : c.name && <small>{c.address}</small>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

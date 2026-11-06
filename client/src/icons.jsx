const P = {
  inbox: 'M4 4h16v10h-5a3 3 0 0 1-6 0H4zM4 14v6h16v-6',
  send: 'M3 11l18-8-8 18-2-8z',
  draft: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  junk: 'M12 3l9 16H3zM12 10v4M12 17v.5',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  folder: 'M3 6h6l2 2h10v11H3z',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  reply: 'M10 9V5l-7 7 7 7v-4c5 0 8 1.5 11 5-1-5-4-10-11-11z',
  replyAll: 'M7 9V5l-6 7 6 7v-4M13 9V5l-7 7 7 7v-4c4 0 7 1.5 9 5-1-5-3.5-10-9-11z',
  forward: 'M14 9V5l7 7-7 7v-4c-5 0-8 1.5-11 5 1-5 4-10 11-11z',
  search: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l5 5',
  plus: 'M12 5v14M5 12h14',
  pen: 'M4 20h4L19 9l-4-4L4 16z',
  close: 'M6 6l12 12M18 6L6 18',
  min: 'M5 18h14',
  max: 'M5 5h14v14H5z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  mail: 'M3 5h18v14H3zM3 5l9 8 9-8',
  mailOpen: 'M3 10l9-6 9 6v10H3zM3 10l9 6 9-6',
  clip: 'M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7',
  refresh: 'M20 11a8 8 0 1 0-2 6M20 5v6h-6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  back: 'M15 18l-6-6 6-6',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  tag: 'M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01',
  move: 'M3 6h6l2 2h10v11H3zM12 13h6M15 10l3 3-3 3',
  check: 'M5 12l5 5 9-10',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM1 21v-1a6 6 0 0 1 12 0v1M16 3.1a4 4 0 0 1 0 7.8M23 21v-1a6 6 0 0 0-4-5.6',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  logout: 'M9 21H4V3h5M16 17l5-5-5-5M21 12H9',
  print: 'M6 9V3h12v6M6 18H3v-8h18v8h-3M6 14h12v7H6z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
  italic: 'M10 4h8M6 20h8M14 4l-4 16',
  underline: 'M6 3v7a6 6 0 0 0 12 0V3M4 21h16',
  list: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  key: 'M15 7a4 4 0 1 1-3.9 5H9v2H7v2H4v-3l6.1-6.1A4 4 0 0 1 15 7z',
  external: 'M14 3h7v7M21 3l-9 9M19 14v7H3V5h7',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
};

export function Icon({ name, size = 18, fill = 'none', className = '', style }) {
  return (
    <svg className={`icon ${className}`} style={style} width={size} height={size} viewBox="0 0 24 24" fill={fill}
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || P.folder} />
    </svg>
  );
}

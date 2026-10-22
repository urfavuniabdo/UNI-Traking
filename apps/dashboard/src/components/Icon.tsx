import type { ReactNode } from 'react';

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const d = PATHS[name];
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={`h-5 w-5 shrink-0 ${className}`}>
      {d}
    </svg>
  );
}

export type IconName =
  | 'live'
  | 'alerts'
  | 'attendance'
  | 'leave'
  | 'reports'
  | 'drivers'
  | 'fences'
  | 'sync'
  | 'settings'
  | 'menu'
  | 'x'
  | 'sun'
  | 'moon'
  | 'sound'
  | 'mute'
  | 'phone'
  | 'whatsapp'
  | 'pin'
  | 'download'
  | 'play'
  | 'pause'
  | 'check'
  | 'chevron';

const PATHS: Record<IconName, ReactNode> = {
  live: <><circle cx="12" cy="10" r="3" /><path d="M12 2a8 8 0 0 0-8 8c0 5.4 8 12 8 12s8-6.6 8-12a8 8 0 0 0-8-8Z" /></>,
  alerts: <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></>,
  attendance: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><path d="m9 16 2 2 4-4" /></>,
  leave: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><path d="M8.5 15.5h7" /></>,
  reports: <><path d="M3 3v18h18" /><path d="m7 9 4 4 6-8" /></>,
  drivers: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 3.5a3.5 3.5 0 0 1 0 7" /><path d="M17.5 13.5a6.5 6.5 0 0 1 4 6.5" /></>,
  fences: <><path d="M9 3 3 6v6l3 9h12l3-9V6l-6-3a4.2 4.2 0 0 0-6 0Z" /><path d="M12 8v5" /><path d="M12 16h.01" /></>,
  sync: <><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  x: <><path d="M18 6 6 18M6 6l12 12" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></>,
  sound: <><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></>,
  mute: <><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="m22 9-6 6m0-6 6 6" /></>,
  phone: <><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 2.6a2 2 0 0 1-.6 1.9L7.5 10.8a16 16 0 0 0 6 6l1.6-1.6a2 2 0 0 1 1.9-.5l2.6.5a2 2 0 0 1 1.7 2Z" /></>,
  whatsapp: <><path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.1-1.3A10 10 0 1 0 12 2Z" /><path d="M8.5 9.5c0 4 3 6.5 6 7 .8.1 1.6-.5 1.6-1.3v-.6l-1.8-1-1 .8c-1.2-.5-2.4-1.6-2.9-2.9l.8-1-1-1.8h-.6c-.7 0-1.1.7-1.1 1.8Z" /></>,
  pin: <><circle cx="12" cy="10" r="3" /><path d="M12 2a8 8 0 0 0-8 8c0 5.4 8 12 8 12s8-6.6 8-12a8 8 0 0 0-8-8Z" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></>,
  play: <><path d="m6 4 14 8-14 8V4Z" /></>,
  pause: <><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></>,
  check: <><path d="m4 12 5 5L20 6" /></>,
  chevron: <><path d="m6 9 6 6 6-6" /></>,
};

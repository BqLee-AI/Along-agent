// Integer civil-time math. No Date, no Intl, no env. Shared by normalize/entry.
export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return isLeapYear(year) ? 29 : 28;
  }
}

export function daysSinceEpoch(year: number, month: number, day: number): number {
  let days = 0;
  for (let y = year; y < 1970; y += 1) days -= isLeapYear(y) ? 366 : 365;
  for (let y = 1970; y < year; y += 1) days += isLeapYear(y) ? 366 : 365;
  for (let m = 1; m < month; m += 1) days += daysInMonth(year, m);
  days += day - 1;
  return days;
}

export interface Civil {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function civilFromEpoch(epochSeconds: number): Civil {
  let days = Math.floor(epochSeconds / 86400);
  const sod = epochSeconds - days * 86400;
  let y = 1970;
  while (days < 0) {
    y -= 1;
    days += isLeapYear(y) ? 366 : 365;
  }
  for (;;) {
    const len = isLeapYear(y) ? 366 : 365;
    if (days < len) break;
    days -= len;
    y += 1;
  }
  let mo = 1;
  for (;;) {
    const len = daysInMonth(y, mo);
    if (days < len) break;
    days -= len;
    mo += 1;
  }
  return {
    y,
    mo,
    d: days + 1,
    h: Math.floor(sod / 3600),
    mi: Math.floor((sod % 3600) / 60),
    s: sod % 60,
  };
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function formatUtc(epochSeconds: number): string {
  const c = civilFromEpoch(epochSeconds);
  return `${String(c.y).padStart(4, '0')}-${pad2(c.mo)}-${pad2(c.d)}T${pad2(c.h)}:${pad2(c.mi)}:${pad2(c.s)}Z`;
}

export interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function readParts(m: RegExpMatchArray): WallParts | null {
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  return { y, mo, d, h, mi, s };
}

export function wallPartsToString(p: WallParts): string {
  return `${String(p.y).padStart(4, '0')}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

export function parseUtcEpoch(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (!m) return null;
  const p = readParts(m);
  if (!p) return null;
  return daysSinceEpoch(p.y, p.mo, p.d) * 86400 + p.h * 3600 + p.mi * 60 + p.s;
}

export function parseWall(value: string): WallParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return readParts(m);
}

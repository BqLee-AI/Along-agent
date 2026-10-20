'use client';
const alias = Date.now;
export const clock = alias();
export const computed = Date['now']();
export const property = new globalThis.Date();
export const parsed = Date.parse('2026-10-20');
export const asserted = new (Date as typeof Date)();

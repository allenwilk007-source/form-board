// Dates shown on pages: "1 Jun 2026", always in UTC so the server's time zone never changes them.
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const showDate = (d: Date) => dateFmt.format(d);
export const showAnswer = (a: string | string[]) => (Array.isArray(a) ? a.join(', ') : a);

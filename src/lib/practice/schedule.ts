/**
 * Turning "I play Tuesdays and Saturdays, about eight times a month" into
 * actual dates in an actual month.
 *
 * PURE, AND SEPARATE FROM THE MODEL, on purpose. Which Tuesdays fall in
 * November is arithmetic, not judgement, and a model asked for dates will
 * eventually hand back a Tuesday that is a Wednesday or a 31st of a 30-day
 * month. The model decides what to PRACTISE; this file decides WHEN, and the
 * two failure modes stay separable.
 */

export interface SchedulePrefs {
  /** 0 = Sunday .. 6 = Saturday. The days they usually play. */
  playDays: number[];
  /** Roughly how many sessions a month they want. */
  sessionsPerMonth: number;
}

/**
 * The dates to schedule in one month, as YYYY-MM-DD.
 *
 * `month` is any date inside the target month. Dates are built and formatted
 * in LOCAL terms throughout -- never via toISOString, which converts to UTC
 * and silently moves a Saturday-evening session in California to Sunday.
 */
export function sessionDates(month: Date, prefs: SchedulePrefs, today?: Date): string[] {
  const year = month.getFullYear();
  const m = month.getMonth();
  const days = normaliseDays(prefs.playDays);
  const wanted = Math.max(0, Math.min(31, Math.round(prefs.sessionsPerMonth)));
  if (wanted === 0) return [];

  const daysInMonth = new Date(year, m + 1, 0).getDate();
  // Don't schedule into the past. A plan generated on the 20th that opens with
  // four sessions you have already missed is a plan that starts by telling you
  // you are behind.
  const from = today && today.getFullYear() === year && today.getMonth() === m ? today.getDate() : 1;

  const candidates: string[] = [];
  for (let d = from; d <= daysInMonth; d++) {
    const date = new Date(year, m, d);
    if (days.length === 0 || days.includes(date.getDay())) candidates.push(iso(date));
  }
  if (candidates.length === 0) return [];
  if (candidates.length <= wanted) return candidates;

  // More candidate days than sessions wanted: spread the sessions across them
  // rather than taking the first n, so a month of practice covers the month
  // rather than its first fortnight.
  return evenSpread(candidates, wanted);
}

/** Valid, de-duplicated, sorted weekdays. Anything else is dropped. */
function normaliseDays(days: readonly number[]): number[] {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

/** Local-date YYYY-MM-DD. Never toISOString — that is UTC and shifts the day. */
export function iso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** First day of the month containing `date`, as YYYY-MM-DD. */
export function monthKey(date: Date): string {
  return iso(new Date(date.getFullYear(), date.getMonth(), 1));
}

function evenSpread<T>(items: readonly T[], count: number): T[] {
  if (count === 1) return [items[0]];
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return [...new Set(out)];
}

/**
 * The calendar grid for a month: whole weeks, Sunday-first, with the days
 * outside the month as nulls.
 *
 * Here rather than in the component because it is the kind of off-by-one that
 * is invisible in a screenshot and obvious in a test -- a month starting on a
 * Sunday, and a month ending on a Saturday, are exactly the cases people get
 * wrong.
 */
export function calendarGrid(month: Date): Array<Array<string | null>> {
  const year = month.getFullYear();
  const m = month.getMonth();
  const first = new Date(year, m, 1);
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const lead = first.getDay();

  const cells: Array<string | null> = Array(lead).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(iso(new Date(year, m, d)));
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

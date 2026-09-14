import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionDates, calendarGrid, iso, monthKey } from "./schedule";

// November 2026: 30 days, starts on a Sunday.
const NOV = new Date(2026, 10, 1);

test("only the weekdays they said they play are scheduled", () => {
  const got = sessionDates(NOV, { playDays: [2, 6], sessionsPerMonth: 30 });
  for (const d of got) {
    const day = new Date(`${d}T12:00:00`).getDay();
    assert.ok(day === 2 || day === 6, `${d} is a ${day}, not a Tuesday or Saturday`);
  }
});

test("the number of sessions matches what they asked for", () => {
  assert.equal(sessionDates(NOV, { playDays: [2, 6], sessionsPerMonth: 4 }).length, 4);
  assert.equal(sessionDates(NOV, { playDays: [1, 3, 5], sessionsPerMonth: 6 }).length, 6);
});

test("fewer candidate days than sessions wanted gives every candidate, not duplicates", () => {
  const got = sessionDates(NOV, { playDays: [0], sessionsPerMonth: 20 });
  assert.equal(new Set(got).size, got.length);
  assert.ok(got.length <= 5, "November has at most five Sundays");
});

test("sessions are spread across the month, not crammed into the first fortnight", () => {
  const got = sessionDates(NOV, { playDays: [0, 1, 2, 3, 4, 5, 6], sessionsPerMonth: 4 });
  const lastDay = Number(got[got.length - 1].slice(-2));
  assert.ok(lastDay > 20, `the last session was on the ${lastDay}, so the month's end is empty`);
});

test("no days given means every day is a candidate", () => {
  assert.equal(sessionDates(NOV, { playDays: [], sessionsPerMonth: 5 }).length, 5);
});

test("nothing is scheduled into the past", () => {
  const got = sessionDates(NOV, { playDays: [0, 1, 2, 3, 4, 5, 6], sessionsPerMonth: 5 }, new Date(2026, 10, 20));
  for (const d of got) assert.ok(Number(d.slice(-2)) >= 20, `${d} is before today`);
});

test("a different month is untouched by today's date", () => {
  const got = sessionDates(new Date(2026, 5, 1), { playDays: [3], sessionsPerMonth: 4 }, new Date(2026, 10, 20));
  assert.ok(got.length > 0, "a different month must not be filtered by today");
  assert.ok(got[0].startsWith("2026-06"));
});

test("zero sessions is zero, not a crash", () => {
  assert.deepEqual(sessionDates(NOV, { playDays: [2], sessionsPerMonth: 0 }), []);
});

test("nonsense weekdays are dropped rather than scheduled", () => {
  const got = sessionDates(NOV, { playDays: [9, -1, 2.5, 2], sessionsPerMonth: 3 });
  for (const d of got) assert.equal(new Date(`${d}T12:00:00`).getDay(), 2);
});

test("dates are local, not UTC — a late session does not slide to the next day", () => {
  // toISOString() on a local midnight in a negative-offset zone yields the
  // PREVIOUS day. That is the bug that would put Saturday's practice on Sunday.
  assert.equal(iso(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(iso(new Date(2026, 11, 31)), "2026-12-31");
  assert.equal(monthKey(new Date(2026, 10, 27)), "2026-11-01");
});

test("the grid is whole weeks, Sunday first", () => {
  for (const month of [new Date(2026, 10, 1), new Date(2026, 1, 1), new Date(2027, 7, 1)]) {
    for (const w of calendarGrid(month)) assert.equal(w.length, 7);
  }
});

test("the grid pads the lead-in and never loses a day", () => {
  // February 2027 starts on a Monday — one leading blank.
  const weeks = calendarGrid(new Date(2027, 1, 1));
  assert.equal(weeks[0][0], null);
  assert.equal(weeks[0][1], "2027-02-01");
  assert.equal(weeks.flat().filter(Boolean).length, 28);
});

test("a month starting on Sunday has no leading blank", () => {
  assert.equal(calendarGrid(NOV)[0][0], "2026-11-01");
});

test("every date in the grid falls inside its own month", () => {
  for (const cell of calendarGrid(new Date(2026, 10, 1)).flat()) {
    if (cell) assert.ok(cell.startsWith("2026-11"), `${cell} leaked into November's grid`);
  }
});

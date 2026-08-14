(function (global) {
  'use strict';

  const DAY_MS = 86400000;
  const parseDate = value => new Date(`${value}T12:00:00`);
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  function addDays(value, days) {
    const date = typeof value === 'string' ? parseDate(value) : new Date(value);
    date.setDate(date.getDate() + Number(days || 0));
    return dateKey(date);
  }

  function cycleStartForDate(value, rebootDay) {
    const date = typeof value === 'string' ? parseDate(value) : new Date(value);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDay() - Number(rebootDay) + 7) % 7));
    return dateKey(date);
  }

  function cycleIdForStart(startDate) { return `cycle-${startDate}`; }

  function splitAmountMinor(amountMinor, count) {
    const amount = Math.max(0, Math.trunc(Number(amountMinor) || 0));
    const parts = Math.max(1, Math.trunc(Number(count) || 1));
    const base = Math.floor(amount / parts);
    const result = Array(parts).fill(base);
    result[parts - 1] += amount - base * parts;
    return result;
  }

  function daysBetween(first, second) {
    return Math.round((parseDate(second) - parseDate(first)) / DAY_MS);
  }

  global.RebootBudgetEngine = Object.freeze({ addDays, cycleIdForStart, cycleStartForDate, dateKey, daysBetween, splitAmountMinor });
})(window);

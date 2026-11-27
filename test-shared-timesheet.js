'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expandSharedTimesheet } = require('./shared-timesheet');
test('expands a shared week without silently approving it', () => {
  const sharedEmployees = ['A One', 'B Two', 'C Three', 'D Four'];
  const sharedDailyHours = [9, 9.5, 9.5, 10.5, 10, 6].map((hours, i) => ({ date: `2026-11-${String(i + 9).padStart(2, '0')}`, hours }));
  const result = expandSharedTimesheet({ layout: 'shared_schedule', sharedEmployees, sharedDailyHours, sharedGrandTotal: 218 });
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[0].dailyHours.reduce((sum, day) => sum + day.hours, 0), 54.5);
  assert.match(result.warning, /подтверждение/);
  assert.match(expandSharedTimesheet({ layout: 'shared_schedule', sharedEmployees, sharedDailyHours, sharedGrandTotal: 200 }).warning, /итог/);
});
test('rejects duplicated dates and names', () => {
  const input = { layout: 'shared_schedule', sharedEmployees: ['A One', 'a one'], sharedDailyHours: [{ date: '2026-11-09', hours: 9 }], sharedGrandTotal: 18 };
  assert.equal(expandSharedTimesheet(input).rows.length, 0);
  input.sharedEmployees = ['A One']; input.sharedDailyHours.push(input.sharedDailyHours[0]);
  assert.equal(expandSharedTimesheet(input).rows.length, 0);
});

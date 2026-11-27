'use strict';

function expandSharedTimesheet(analysis) {
  if (analysis?.layout !== 'shared_schedule') return { rows: Array.isArray(analysis?.entries) ? analysis.entries : [], warning: '' };
  const names = Array.isArray(analysis.sharedEmployees) ? analysis.sharedEmployees.filter(name => typeof name === 'string' && name.trim()) : [];
  const days = Array.isArray(analysis.sharedDailyHours) ? analysis.sharedDailyHours : [];
  const total = Number(analysis.sharedGrandTotal);
  const hours = days.reduce((sum, item) => sum + (Number(item.hours) || 0), 0);
  const valid = names.length > 0 && new Set(names.map(name => name.trim().toLocaleLowerCase())).size === names.length
    && days.length > 0 && days.every(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) && Number.isFinite(Number(item.hours)) && Number(item.hours) >= 0 && Number(item.hours) <= 24)
    && new Set(days.map(item => item.date)).size === days.length;
  if (!valid) return { rows: [], warning: 'Общий график заполнен неоднозначно: проверьте имена и даты.' };
  const warning = !(total > 0) || Math.abs(hours * names.length - total) > 0.1
    ? 'Общий итог не подтверждает одинаковые часы для всех сотрудников.'
    : 'Общие часы на нескольких сотрудников: требуется подтверждение владельца.';
  return { rows: names.map(personName => ({ personName, dailyHours: days })), warning };
}
module.exports = { expandSharedTimesheet };

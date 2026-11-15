export const JOBS = [
  { name: 'rotate_logs', cron: '0 3 * * *' },
  { name: 'rotate_reports', cron: '0 5 * * *' },
  { name: 'rotate_audit', cron: '0 6 * * *' },
];
export const ROTATE_KEEP_DAYS = 14;

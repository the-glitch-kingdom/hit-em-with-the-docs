export const JOBS = [
  { name: 'nightly_backup', cron: '0 2 * * *' },
  { name: 'hourly_sync', cron: '0 * * * *' },
  { name: 'weekly_digest', cron: '0 8 * * 1' },
];

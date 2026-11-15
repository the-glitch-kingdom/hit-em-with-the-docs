import { describe, it, expect } from 'vitest';
import { name_cron_command } from '../../../src/core/coverage/surfaces/detectors.js';

describe('cron command naming: user column, wrapper options', () => {
  it('drops the user column before cd/&& splitting', () => {
    expect(name_cron_command('root cd /app && ./xx.sh', true)).toBe('xx');
    expect(name_cron_command('www-data cd /srv && php artisan queue:work', true)).toBe('queue:work');
    expect(name_cron_command('root cd /app && ./xx.sh')).toBe('xx');
    expect(name_cron_command('www-data cd /srv && php artisan queue:work')).toBe('queue:work');
    expect(name_cron_command('deploy cd /srv && ./yy.sh')).toBe('yy');
  });
  it('skips wrapper options and their values', () => {
    expect(name_cron_command('timeout -s KILL 300 /app/slow.sh')).toBe('slow');
    expect(name_cron_command('npm run --silent sync')).toBe('sync');
    expect(name_cron_command('run-parts /etc/cron.hourly')).toBe('cron.hourly');
    expect(name_cron_command('docker exec -it web /app/bin/purge.sh')).toBe('purge');
  });
});

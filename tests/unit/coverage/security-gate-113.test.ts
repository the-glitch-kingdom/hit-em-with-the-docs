import { describe, it, expect } from 'vitest';
import { check_security_gate, check_credential_text, is_security_sensitive } from '../../../src/core/security/gate.js';

const config = { allow: [], disabled_rules: [] };
const rules = (text: string): string[] => check_security_gate(text, 'draft', config).map((finding) => finding.rule);

describe('security gate (#113)', () => {
  it('blocks values: hosts, IPs, ports, ids, connection strings, key contents, env values and defaults', () => {
    const fake_ip = ['10', '0', '3', '7'].join('.');
    expect(rules(`connects to ${fake_ip} now`)).toContain('ip-address');
    expect(rules('calls api.internal.example.com daily')).toContain('hostname');
    expect(rules('listens on port 8443')).toContain('port');
    expect(rules('the project_id is prj-123456')).toContain('account-id');
    expect(rules('account 123456789012 owns it')).toContain('account-id');
    expect(rules('uses postgres://user:pw@db/app')).toContain('connection-string');
    expect(rules('-----BEGIN ' + 'PRIVATE KEY-----')).toContain('key-material');
    expect(rules('set CACHE_TTL=3600 in the env')).toContain('config-value');
    expect(rules('the timeout defaults to 30 seconds')).toContain('config-value');
  });
  it('allows env and config names, paths with lines, and identifiers', () => {
    expect(rules('`CACHE_TTL` is read from `src/cache.ts` (line 12); see `refresh_token()` and `HEWTD_DEBUG`.')).toEqual([]);
  });
  it('reports findings masked, with where:line, never the value', () => {
    const f = check_security_gate('ok\nport 8443', 'draft', config)[0]!;
    expect(f).toMatchObject({ file: 'draft', line: 2 });
    expect(JSON.stringify(f)).not.toContain('8443');
  });
  it('credential check on a source line uses the secrets scan', () => {
    const token = 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK';
    expect(check_credential_text(`aws_key = "${token}"`, 'src/a.ts', config)).toHaveLength(1);
    expect(check_credential_text('retry_limit = 5', 'src/a.ts', config)).toEqual([]);
  });
  it('security-sensitive topics are recognised', () => {
    for (const t of ['how does token validation bypass work', 'the IAM policy for the bucket', 'firewall ingress rules', 'permission check on delete', 'src/auth/session.ts']) expect(is_security_sensitive(t), t).toBe(true);
    for (const t of ['how long is the cache ttl', 'the author field', 'retry limit of the queue']) expect(is_security_sensitive(t), t).toBe(false);
  });
});

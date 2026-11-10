import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { build_repo_index, check_doc_references } from '../../../src/core/reconcile/references';
import { triage_docs } from '../../../src/core/reconcile/triage';
import { load_plugin_config } from '../../../src/utils/config';

let root: string;
const put = (file: string, text: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf-8' });

const MODELS = `
class Base(DeclarativeBase): pass

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String)
    display = Column("display_name", String)
    posts = relationship("Post")

audit = Table("audit_log", metadata, Column("id", Integer), Column("action", String, nullable=False))
`;
const DJANGO = `
class Order(models.Model):
    total = models.DecimalField()
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE)
    tags = models.ManyToManyField(Tag)

class Legacy(models.Model):
    code = models.CharField()
    class Meta:
        db_table = "legacy_codes"
`;
const DOC = [
  'Table `SELECT * FROM users`, real column `users.email`, renamed `users.display_name`, removed `users.nickname`.',
  'Audit `audit_log.action`, Django `shop_order.total`, `shop_order.customer_id`, `legacy_codes.code`, gone `shop_order.discount`.',
  'Catalogs `SELECT * FROM information_schema.tables` and `SELECT * FROM pg_indexes`.',
  'Task `jobs.sync`, JSON `result.total`, attribute `current_user.email`.',
].join('\n\n');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orm-93-'));
  put('app/models.py', MODELS);
  put('shop/models.py', DJANGO);
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ORM schema sources and table refs (#93)', () => {
  it('reads SQLAlchemy and Django models; only the removed columns are missing', async () => {
    const index = build_repo_index(root, ['app/models.py', 'shop/models.py']);
    expect(index.schema_files).toEqual(['app/models.py', 'shop/models.py']);
    const result = await check_doc_references(index, DOC);
    const missing = result.filter((entry) => entry.status === 'missing').map((entry) => entry.ref);
    expect(missing).toEqual(['users.nickname', 'shop_order.discount']);
    const ok = result.filter((entry) => entry.status === 'ok').map((entry) => entry.ref);
    expect(ok).toEqual(expect.arrayContaining(['users', 'users.email', 'users.display_name', 'audit_log.action', 'shop_order.total', 'shop_order.customer_id', 'legacy_codes.code']));
    for (const name of ['information_schema.tables', 'pg_indexes', 'jobs.sync', 'result.total', 'current_user.email']) {
      expect(result.find((entry) => entry.ref === name)?.status, name).not.toBe('missing');
    }
  });

  it('a schema_sources pattern that matches no tracked file is a triage warning', async () => {
    put('.hewtd/schema.sql', 'CREATE TABLE users (id int);\n');
    put('.documentation/a.md', '# A\n\n`users.id`\n');
    g('add', '.documentation'); g('commit', '-qm', 'doc');
    const config = await load_plugin_config(root);
    config.reconcile.schema_sources = ['.hewtd/schema.sql', 'app/models.py'];
    const result = await triage_docs({ root, docs_root: join(root, '.documentation'), rels: ['a.md'], config });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('.hewtd/schema.sql');
    expect(result.warnings[0]).toContain('tracked by git');
  });
});

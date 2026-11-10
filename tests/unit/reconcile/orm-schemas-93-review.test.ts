import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { build_repo_index, check_doc_references } from '../../../src/core/reconcile/references';

let root: string;
const put = (file: string, text: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
const status_of = async (sources: string[], doc: string) => {
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
  const result = await check_doc_references(build_repo_index(root, sources), doc);
  return Object.fromEntries(result.map((entry) => [entry.ref, entry.status]));
};
const setup = () => { root = mkdtempSync(join(tmpdir(), 'orm-93r-')); };
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('review fixes for #93', () => {
  it('the catalog test applies to the owner only, after known tables', async () => {
    setup();
    put('db/schema.sql', 'CREATE TABLE users (id int);\nCREATE TABLE pg_users (id int, pg_flag int);\nCREATE TABLE orders (id int, sqlite_path text);\n');
    const s = await status_of(['db/schema.sql'], 'Cols `users.pg_id`, `orders.sqlite_gone`, `pg_users.gone`, `pg_users.pg_flag`, `orders.sqlite_path`. `SELECT * FROM pg_users` `SELECT * FROM pg_indexes` `SELECT * FROM sqlite_master` `SELECT * FROM information_schema.tables` `SELECT * FROM mysql.user`');
    expect(s['users.pg_id']).toBe('missing');
    expect(s['orders.sqlite_gone']).toBe('missing');
    expect(s['pg_users.gone']).toBe('missing');
    expect(s['pg_users.pg_flag']).toBe('ok');
    expect(s['orders.sqlite_path']).toBe('ok');
    expect(s['pg_users']).toBe('ok');
    for (const name of ['pg_indexes', 'sqlite_master', 'information_schema.tables', 'mysql.user']) expect(s[name], name).toBe('unknown');
  });

  it('SQL-derived refs to an unknown table stay missing; code-span dotted refs are unknown', async () => {
    setup();
    put('db/schema.sql', 'CREATE TABLE users (id int);\n');
    const s = await status_of(['db/schema.sql'], '```sql\nALTER TABLE old_users ADD COLUMN email text;\nSELECT * FROM gone_table;\n```\n\n`current_user.email` `users.nope`');
    expect(s['old_users.email']).toBe('missing');
    expect(s['gone_table']).toBe('missing');
    expect(s['current_user.email']).toBe('unknown');
    expect(s['users.nope']).toBe('missing');
  });

  it('SQLAlchemy name= keyword and mixin columns', async () => {
    setup();
    put('app/models.py', `
class TimestampMixin:
    created_at = Column(DateTime)

class User(Base, TimestampMixin):
    __tablename__ = "users"
    id = Column(Integer)
    nick = mapped_column(String, name="nick_name")
    other = Column(String, name="other_name")
`);
    const s = await status_of(['app/models.py'], '`users.nick_name` `users.created_at` `users.other_name` `users.nick`');
    expect(s['users.nick_name']).toBe('ok');
    expect(s['users.created_at']).toBe('ok');
    expect(s['users.other_name']).toBe('ok');
    expect(s['users.nick']).toBe('missing');
  });

  it('Django abstract models are not tables but pass their fields on', async () => {
    setup();
    put('shop/models.py', `
class Abs(models.Model):
    name = models.CharField()
    class Meta:
        abstract = True

class Mid(Abs):
    extra = models.CharField()
    class Meta:
        abstract = True

class Product(Mid):
    price = models.IntegerField()
`);
    const s = await status_of(['shop/models.py'], '`SELECT * FROM shop_abs` `SELECT * FROM shop_product` `shop_product.name` `shop_product.extra` `shop_product.price`');
    expect(s['shop_abs']).toBe('missing');
    expect(s['shop_product']).toBe('ok');
    expect(s['shop_product.name']).toBe('ok');
    expect(s['shop_product.extra']).toBe('ok');
    expect(s['shop_product.price']).toBe('ok');
  });
});

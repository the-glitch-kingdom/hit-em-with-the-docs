/**
 * Reconcile: table and column names declared in Python ORM code (SQLAlchemy, Django), regex-level like
 * parse_sql / parse_prisma. shortcut: no AST, so tables built in loops or computed names are not seen.
 */
import { basename, dirname } from 'path';
import type { Schema } from './references.js';

const SQLALCHEMY_COLUMN = /^[ \t]+(\w+)[ \t]*(?::[^=\n]+)?=[ \t]*(?:\w+\.)*(?:Column|mapped_column)\(\s*(?:["'](\w+)["'])?/gm;
const DJANGO_FIELD = /^[ \t]+(\w+)[ \t]*=[ \t]*(?:\w+\.)*(\w*(?:Field|ForeignKey|OneToOneField))\(/gm;

function add_table(schema: Schema, table: string, columns: Iterable<string>): void {
  const key = table.toLowerCase();
  schema.tables.set(key, new Set([...(schema.tables.get(key) ?? []), ...[...columns].map((column) => column.toLowerCase())]));
}

/** Text between the parenthesis that opens at `open_index` and its match. */
function get_balanced_body(text: string, open_index: number): string {
  let depth = 0;
  for (let i = open_index; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open_index + 1, i);
  }
  return text.slice(open_index + 1);
}

export function parse_python_orm(source: string, schema: Schema, file: string): void {
  const text = source.replace(/^[ \t]*#.*$/gm, '');
  for (const match of text.matchAll(/\bTable\(\s*["'](\w+)["']/g)) {
    const body = get_balanced_body(text, match.index! + match[0].indexOf('('));
    add_table(schema, match[1]!, [...body.matchAll(/\bColumn\(\s*["'](\w+)["']/g)].map((column) => column[1]!));
  }
  const starts = [...text.matchAll(/^class\s+\w+\s*\(([^)]*)\)/gm)];
  starts.forEach((start, i) => {
    const block = text.slice(start.index!, starts[i + 1]?.index ?? text.length);
    const table_name = /^[ \t]+__tablename__\s*=\s*["'](\w+)["']/m.exec(block)?.[1];
    if (table_name) {
      add_table(schema, table_name, [...block.matchAll(SQLALCHEMY_COLUMN)].map((column) => column[2] ?? column[1]!));
    } else if (/(?:^|[\s,.])Model\b/.test(start[1]!)) {
      const model = /^class\s+(\w+)/.exec(start[0])![1]!;
      // a models/ package: the app is the folder above it
      const app = basename(dirname(file)) === 'models' ? basename(dirname(dirname(file))) : basename(dirname(file));
      const db_table = /\bdb_table\s*=\s*["'](\w+)["']/.exec(block)?.[1] ?? `${app}_${model.toLowerCase()}`;
      const columns = ['id'];
      for (const field of block.matchAll(DJANGO_FIELD)) {
        if (field[2] === 'ManyToManyField') continue;
        columns.push(field[1]!);
        if (/ForeignKey|OneToOneField/.test(field[2]!)) columns.push(`${field[1]}_id`);
      }
      add_table(schema, db_table, columns);
    }
  });
}

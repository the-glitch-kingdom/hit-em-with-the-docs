/**
 * Reconcile: table and column names declared in Python ORM code (SQLAlchemy, Django), regex-level like
 * parse_sql / parse_prisma. shortcut: no AST, so tables built in loops or computed names are not seen.
 */
import { basename, dirname } from 'path';
import type { Schema } from './references.js';

const SQLALCHEMY_COLUMN = /^[ \t]+(\w+)[ \t]*(?::[^=\n]+)?=[ \t]*(?:\w+\.)*(?:Column|mapped_column)(?=\()/gm;
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

/** The call's top-level arguments only: nested calls (`ForeignKey("a.b", name="fk")`) are blanked. */
function get_top_level_arguments(body: string): string {
  let text = body;
  for (let previous = ''; previous !== text;) { previous = text; text = text.replace(/\([^()]*\)/g, '()'); }
  return text;
}

interface OrmClass { name: string; bases: string[]; block: string; file: string }

function get_own_columns(orm_class: OrmClass, is_django: boolean): string[] {
  const columns: string[] = [];
  if (is_django) {
    for (const field of orm_class.block.matchAll(DJANGO_FIELD)) {
      if (field[2] === 'ManyToManyField') continue;
      columns.push(field[1]!);
      if (/ForeignKey|OneToOneField/.test(field[2]!)) columns.push(`${field[1]}_id`);
    }
    return columns;
  }
  for (const column of orm_class.block.matchAll(SQLALCHEMY_COLUMN)) {
    const call = get_top_level_arguments(get_balanced_body(orm_class.block, column.index! + column[0].length));
    // the name= keyword, then a leading string argument, win over the attribute name
    columns.push(/\bname\s*=\s*["'](\w+)["']/.exec(call)?.[1] ?? /^\s*["'](\w+)["']/.exec(call)?.[1] ?? column[1]!);
  }
  return columns;
}

/** Parses every Python schema source together, so a base class in one file reaches the tables in another. */
export function parse_python_orm(sources: Array<{ file: string; text: string }>, schema: Schema): void {
  const classes = new Map<string, OrmClass>();
  for (const { file, text: source } of sources) {
    const text = source.replace(/^[ \t]*#.*$/gm, '');
    for (const match of text.matchAll(/\bTable\(\s*["'](\w+)["']/g)) {
      const body = get_balanced_body(text, match.index! + match[0].indexOf('('));
      add_table(schema, match[1]!, [...body.matchAll(/\bColumn\(\s*["'](\w+)["']/g)].map((column) => column[1]!));
    }
    const starts = [...text.matchAll(/^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/gm)];
    starts.forEach((start, i) => {
      const bases = (start[2] ?? '').split(',').filter((base) => !base.includes('=')).map((base) => /(\w+)\s*(?:\[.*\])?\s*$/.exec(base)?.[1]).filter((base): base is string => !!base);
      classes.set(start[1]!, { name: start[1]!, bases, block: text.slice(start.index!, starts[i + 1]?.index ?? text.length), file });
    });
  }
  const is_django = (orm_class: OrmClass, seen: Set<string> = new Set()): boolean => {
    if (seen.has(orm_class.name)) return false;
    seen.add(orm_class.name);
    return orm_class.bases.some((base) => base === 'Model' || (classes.has(base) && is_django(classes.get(base)!, seen)));
  };
  /** Own columns plus those of every base class in the parsed files. */
  const get_columns = (orm_class: OrmClass, seen: Set<string> = new Set()): string[] => {
    if (seen.has(orm_class.name)) return [];
    seen.add(orm_class.name);
    const inherited = orm_class.bases.flatMap((base) => (classes.has(base) ? get_columns(classes.get(base)!, seen) : []));
    return [...inherited, ...get_own_columns(orm_class, is_django(orm_class))];
  };
  for (const orm_class of classes.values()) {
    const table_name = /^[ \t]+__tablename__\s*=\s*["'](\w+)["']/m.exec(orm_class.block)?.[1];
    if (table_name) {
      add_table(schema, table_name, get_columns(orm_class));
    } else if (is_django(orm_class) && !/^[ \t]+abstract\s*=\s*True\b/m.test(orm_class.block)) {
      // a models/ package: the app is the folder above it
      const app = basename(dirname(orm_class.file)) === 'models' ? basename(dirname(dirname(orm_class.file))) : basename(dirname(orm_class.file));
      const db_table = /\bdb_table\s*=\s*["'](\w+)["']/.exec(orm_class.block)?.[1] ?? `${app}_${orm_class.name.toLowerCase()}`;
      add_table(schema, db_table, ['id', ...get_columns(orm_class)]);
    }
  }
}

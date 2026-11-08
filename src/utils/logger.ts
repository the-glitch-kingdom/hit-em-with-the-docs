import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export interface LoggerOptions {
  silent?: boolean;
  verbose?: boolean;
  prefix?: string;
}

class Logger {
  private silent: boolean = false;
  private verbose: boolean = false;
  private prefix: string = '';

  configure(options: LoggerOptions): void {
    if (options.silent !== undefined) this.silent = options.silent;
    if (options.verbose !== undefined) this.verbose = options.verbose;
    if (options.prefix !== undefined) this.prefix = options.prefix;
  }

  private format_message(message: string): string {
    return this.prefix ? `${this.prefix} ${message}` : message;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.silent || !this.verbose) return;
    console.log(chalk.gray(`[DEBUG] ${this.format_message(message)}`), ...args);
  }

  info(message: string, ...args: unknown[]): void {
    if (this.silent) return;
    console.log(chalk.blue('ℹ'), this.format_message(message), ...args);
  }

  success(message: string, ...args: unknown[]): void {
    if (this.silent) return;
    console.log(chalk.green('✓'), this.format_message(message), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.silent) return;
    console.log(chalk.yellow('⚠'), this.format_message(message), ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(chalk.red('✗'), this.format_message(message), ...args);
  }

  // Styled output helpers
  header(title: string): void {
    if (this.silent) return;
    console.log();
    console.log(chalk.bold.cyan(`━━━ ${title} ━━━`));
    console.log();
  }

  subheader(title: string): void {
    if (this.silent) return;
    console.log();
    console.log(chalk.bold(title));
  }

  list(items: string[], indent: number = 0): void {
    if (this.silent) return;
    const prefix = '  '.repeat(indent);
    items.forEach((item) => {
      console.log(`${prefix}• ${item}`);
    });
  }

  table(headers: string[], rows: string[][]): void {
    if (this.silent) return;
    const col_widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))
    );

    const separator = col_widths.map((w) => '─'.repeat(w + 2)).join('┼');
    const header_row = headers
      .map((h, i) => ` ${h.padEnd(col_widths[i] ?? 0)} `)
      .join('│');

    console.log(chalk.gray(`┌${separator.replace(/┼/g, '┬')}┐`));
    console.log(chalk.bold(`│${header_row}│`));
    console.log(chalk.gray(`├${separator}┤`));

    rows.forEach((row) => {
      const row_str = row
        .map((cell, i) => ` ${(cell ?? '').padEnd(col_widths[i] ?? 0)} `)
        .join('│');
      console.log(`│${row_str}│`);
    });

    console.log(chalk.gray(`└${separator.replace(/┼/g, '┴')}┘`));
  }

  progress(current: number, total: number, label?: string): void {
    if (this.silent) return;
    const percentage = Math.round((current / total) * 100);
    const bar_width = 30;
    const filled = Math.round((current / total) * bar_width);
    const empty = bar_width - filled;
    const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    const label_str = label ? ` ${label}` : '';
    process.stdout.write(`\r${bar} ${percentage}%${label_str}`);
    if (current === total) console.log();
  }

  newline(): void {
    if (this.silent) return;
    console.log();
  }

  // Emoji helpers
  emoji = {
    docs: '📚',
    check: '✅',
    cross: '❌',
    warn: '⚠️',
    info: 'ℹ️',
    search: '🔍',
    stats: '📊',
    fix: '🔧',
    link: '🔗',
    folder: '📁',
    file: '📄',
    clock: '⏱️',
    sparkles: '✨',
  };
}

export const logger = new Logger();
export default logger;

/**
 * A whole-file lexer that finds the lines a security check cannot be on (#120): lines wholly inside a block comment, or a
 * Python docstring. It tracks state across lines (normal, line comment, block comment, every string form), so a `/*` or
 * `=begin` or `"""` inside a string, template literal, raw_string string or heredoc opens nothing.
 *
 * Fails closed: when the lexer meets anything it cannot classify, or ends in a state other than normal, it marks nothing
 * for the file, and the caller then holds every check as 3.7.0 did. Only a bias towards "this is code" is safe here, so
 * every guess in this file errs towards reading text as code, never towards reading code as prose.
 * shortcut: shell, Swift string interpolation and Kotlin `${}` with a nested quote are not tracked; upgrade with a parser per language.
 */

class Abort extends Error {}
const give_up = (): never => { throw new Abort(); };

const JS_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx']);
const C_FAMILY = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp']);
const NESTED_COMMENTS = new Set(['rs', 'kt', 'kts', 'swift', 'scala']);
const TRIPLE_STRINGS = new Set(['java', 'kt', 'kts', 'swift', 'scala', 'cs']);
const C_STYLE = new Set([...JS_EXTENSIONS, ...C_FAMILY, ...NESTED_COMMENTS, ...TRIPLE_STRINGS, 'go', 'php', 'css', 'scss', 'less']);
// a `/` after one of these starts a regex literal; `of`, `yield` and `await` can also be plain identifiers, so they are ambiguous
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'case', 'in', 'delete', 'void', 'throw', 'new', 'else', 'do', 'default']);
// Prose is read only where a real parser checks the lexer (Python ast, the TypeScript parser, go/scanner, gcc); every
// other language holds every line, as 3.7.0 did. Interpolation in Kotlin, Swift, Scala, C# and PHP is not tracked (#120).
const PARSER_CHECKED = new Set(['py', 'pyi', ...JS_EXTENSIONS, ...C_FAMILY, 'go']);
const AMBIGUOUS_KEYWORDS = new Set(['of', 'yield', 'await']);
const PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
type Reading = 'regex' | 'division' | 'ambiguous';
const WORD = /[\w$]/;
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

class Lexer {
  pos = 0;
  line = 0;
  last_sig = '';
  last_word = '';
  private prev_sig = '';
  private last_word_is_property = false;
  private last_paren: Reading = 'ambiguous';
  private parens: Reading[] = []; // per open `(`: what a `/` after its `)` means
  private trial = false; // a throwaway fork that lexes the rest of one line one way
  private trial_depth = 0;
  readonly prose_lines = new Set<number>();
  readonly code_lines = new Set<number>();
  // python logical lines: the head of the previous statement decides whether a triple string is a docstring
  private nest = 0;
  private bracket = 0;
  private stmt_started = false;
  private stmt_start = 0;
  private previous: { is_def: boolean; colon: boolean } | undefined;
  private pending: { id: string; strip: boolean }[] = [];
  constructor(private readonly text: string, private readonly extension: string, private readonly family: 'python' | 'c' | 'ruby') {}

  private starts(text: string, at = this.pos): boolean { return this.text.startsWith(text, at); }
  private match(regex: RegExp): RegExpExecArray | null { regex.lastIndex = this.pos; return regex.exec(this.text); }

  private consume(mode: 'code' | 'prose' | 'comment' = 'code', count = 1): void {
    for (let i = 0; i < count; i++) {
      if (this.pos >= this.text.length) give_up();
      const char = this.text[this.pos++]!;
      if (char === '\n') { if (this.trial) give_up(); this.line++; continue; }
      if (/\s/.test(char)) continue;
      if (mode === 'prose') { this.prose_lines.add(this.line); continue; }
      this.code_lines.add(this.line);
      if (mode === 'comment') continue;
      this.prev_sig = this.last_sig;
      this.last_sig = char;
      if (this.family === 'python' && !this.nest && !this.stmt_started) { this.stmt_started = true; this.stmt_start = this.pos - 1; }
    }
  }
  private consume_to_line_end(mode: 'code' | 'comment' = 'comment'): void { while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.consume(mode); }
  private is_line_start(): boolean { return this.pos === 0 || this.text[this.pos - 1] === '\n'; }

  run(): void {
    if (this.family === 'python') this.scan_python(false);
    else if (this.family === 'ruby') this.scan_ruby();
    else this.scan_c(false);
    if (this.pending.length) give_up();
  }

  // a newline ends the line a heredoc opened on: its bodies follow
  private end_line(): void {
    this.consume();
    const pending = this.pending;
    this.pending = [];
    for (const heredoc of pending) this.read_heredoc(heredoc);
  }
  private read_heredoc({ id, strip }: { id: string; strip: boolean }): void {
    const php = this.family === 'c';
    for (;;) {
      if (this.pos >= this.text.length) give_up();
      const end = this.text.indexOf('\n', this.pos);
      const row = this.text.slice(this.pos, end < 0 ? undefined : end);
      if (php ? new RegExp(`^[ \\t]*${id}(?!\\w)`).test(row) : (strip ? row.trim() : row.replace(/\r$/, '')) === id) {
        // php: only the id ends the heredoc, the rest of the line is code; ruby: the whole line is the terminator
        this.consume('code', php ? /^[ \t]*\w+/.exec(row)![0].length : row.length);
        if (!php && end >= 0) this.consume();
        return;
      }
      this.consume('code', row.length);
      if (end < 0) give_up();
      this.consume();
    }
  }

  // ---- strings shared by the families ----
  private scan_simple_string(multiline: boolean, interpolate = false): void {
    const delim = this.text[this.pos]!;
    this.consume();
    for (;;) {
      if (this.pos >= this.text.length) give_up();
      const char = this.text[this.pos]!;
      if (char === '\\') this.consume('code', 2);
      else if (char === '\n' && !multiline) give_up();
      else if (char === delim) { this.consume(); return; }
      else if (interpolate && this.starts('#{')) this.interpolate_ruby();
      else this.consume();
    }
  }
  private scan_until(delim: string, escapes: boolean): void {
    for (;;) {
      if (this.pos >= this.text.length) give_up();
      if (escapes && this.text[this.pos] === '\\') this.consume('code', 2);
      else if (this.starts(delim)) { this.consume('code', delim.length); return; }
      else this.consume();
    }
  }
  private interpolate_ruby(): void { this.consume('code', 2); this.scan_ruby(true); this.consume(); }

  // ---- python ----
  private end_statement(): void {
    if (!this.stmt_started) return;
    this.previous = { is_def: /^(?:async\s+)?(?:def|class)\b/.test(this.text.slice(this.stmt_start, this.stmt_start + 40)), colon: this.last_sig === ':' };
    this.stmt_started = false;
  }
  private scan_python(nested: boolean): void {
    let depth = 0;
    this.nest += nested ? 1 : 0;
    const flush = (): void => { this.nest -= nested ? 1 : 0; };
    for (;;) {
      if (this.pos >= this.text.length) { if (nested) give_up(); return flush(); }
      const char = this.text[this.pos]!;
      if (nested && char === '}' && !depth) return flush();
      if (char === '\n') { this.consume(); if (!this.bracket && !nested) this.end_statement(); continue; }
      if (char === '\\' && this.text[this.pos + 1] === '\n') { this.consume('code', 2); continue; }
      if (char === '#') { this.consume_to_line_end(); continue; }
      if (/\s/.test(char)) { this.consume(); continue; }
      if (WORD.test(char)) {
        const word = this.match(/\w+/y)![0];
        const quote = this.text[this.pos + word.length];
        if (/^[rRbBuUfF]{1,2}$/.test(word) && (quote === '"' || quote === "'")) { this.scan_python_string(word); continue; }
        this.consume('code', word.length);
        continue;
      }
      if (char === '"' || char === "'") { this.scan_python_string(''); continue; }
      if (char === '{') depth++;
      if (char === '}' && depth) depth--;
      if (!nested) { if ('([{'.includes(char)) this.bracket++; else if (')]}'.includes(char) && this.bracket) this.bracket--; }
      this.consume();
    }
  }
  private scan_python_string(prefix: string): void {
    const quote = this.text[this.pos + prefix.length]!;
    const triple = this.starts(quote.repeat(3), this.pos + prefix.length);
    const is_f = /f/i.test(prefix);
    if (triple && /^[rRuU]?$/.test(prefix) && !this.stmt_started && !this.bracket && !this.nest && (!this.previous || this.previous.is_def && this.previous.colon)) {
      // a docstring: the first statement of the module, or the first after a def/class header, with nothing after the closing quotes
      let at = this.pos + prefix.length + 3;
      while (at < this.text.length && !this.starts(quote.repeat(3), at)) at += this.text[at] === '\\' ? 2 : 1;
      if (at < this.text.length && /^[ \t\r]*(?:#[^\n]*)?(?:\n|$)/.test(this.text.slice(at + 3, at + 3 + 400).split('\n')[0]! + '\n')) {
        const start = this.pos;
        this.consume('prose', at + 3 - start);
        this.stmt_started = true;
        this.stmt_start = start;
        return;
      }
    }
    this.consume('code', prefix.length + (triple ? 3 : 1));
    for (;;) {
      if (this.pos >= this.text.length) give_up();
      const char = this.text[this.pos]!;
      if (char === '\\') this.consume('code', 2);
      else if (triple ? this.starts(quote.repeat(3)) : char === quote) { this.consume('code', triple ? 3 : 1); return; }
      else if (char === '\n' && !triple) give_up();
      else if (is_f && char === '{' && this.text[this.pos + 1] === '{') this.consume('code', 2);
      else if (is_f && char === '{') { this.consume(); this.scan_python(true); this.consume(); }
      else this.consume();
    }
  }

  // ---- c-style ----
  private scan_c(nested: boolean, start_depth = 0): void {
    const extension = this.extension;
    const js = JS_EXTENSIONS.has(extension);
    const jsx_possible = extension === 'js' || extension === 'mjs' || extension === 'cjs';
    const php = extension === 'php';
    let depth = start_depth;
    for (;;) {
      if (this.pos >= this.text.length) { if (nested) give_up(); this.trial_depth = depth; return; }
      const char = this.text[this.pos]!;
      if (nested && char === '}' && !depth) { this.trial_depth = depth; return; }
      if (char === '\n') { if (this.trial) { this.trial_depth = depth; return; } this.end_line(); continue; }
      if (/\s/.test(char)) { this.consume(); continue; }
      if (char === '/' && this.text[this.pos + 1] === '*') { this.scan_block_comment(); continue; }
      if (char === '/' && this.text[this.pos + 1] === '/' && extension !== 'css') { this.scan_line_comment(); continue; }
      if (php && char === '#' && this.text[this.pos + 1] !== '[') { this.consume_to_line_end(); continue; }
      if (js && char === '#' && this.text[this.pos + 1] === '!' && this.pos === (this.text[0] === '\uFEFF' ? 1 : 0)) { this.consume_to_line_end(); continue; } // hashbang
      if (C_FAMILY.has(extension) && char === '#') {
        const header = this.match(/#[ \t]*(?:include|include_next|import)[ \t]*<[^>\n]*>/y); // a header name is not lexed for comments
        if (header) { this.consume('code', header[0].length); continue; }
      }
      if (jsx_possible && char === '<' && /[A-Za-z_$>/]/.test(this.text[this.pos + 1] ?? '') && this.classify_slash() !== 'division') give_up(); // JSX text is not lexed
      if (WORD.test(char)) { this.scan_c_word(); continue; }
      if (char === '"') {
        if (TRIPLE_STRINGS.has(extension) && this.starts('"""')) { this.consume('code', 3); this.scan_until('"""', true); }
        else this.scan_simple_string(extension === 'rs' || php);
        continue;
      }
      if (char === '@' && extension === 'cs' && this.text[this.pos + 1] === '"') { // verbatim: `""` is a quote, nothing else escapes
        this.consume('code', 2);
        for (;;) { this.scan_until('"', false); if (this.text[this.pos] === '"') this.consume(); else break; }
        continue;
      }
      if (char === "'") {
        const rune = extension === 'rs' || extension === 'scala' ? this.match(/'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/y) : null;
        if (rune) this.consume('code', rune[0].length);
        else if (extension === 'rs' || extension === 'scala') this.consume(); // a lifetime or a symbol
        else this.scan_simple_string(php);
        continue;
      }
      if (char === '`') {
        if (js) this.scan_template();
        else if (extension === 'go') { this.consume(); this.scan_until('`', false); }
        else if (php) this.scan_simple_string(true);
        else if (['kt', 'kts', 'swift', 'scala'].includes(extension)) this.scan_simple_string(false);
        else this.consume();
        continue;
      }
      if (php && this.starts('<<<')) {
        const heredoc = this.match(/<<<[ \t]*(?:"(\w+)"|'(\w+)'|(\w+))/y);
        if (heredoc) { this.pending.push({ id: (heredoc[1] ?? heredoc[2] ?? heredoc[3])!, strip: true }); this.consume('code', heredoc[0].length); continue; }
      }
      if (js && char === '/') {
        const reading = this.classify_slash();
        const regex = reading === 'division' ? null : this.match(/\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\//y);
        if (regex) {
          // a `/` that could be either: lex the rest of the line both ways and trust the file only if both end in the same state
          if (reading === 'ambiguous' && (this.trial || this.read_rest_of_line(regex[0].length, nested, depth) !== this.read_rest_of_line(0, nested, depth))) give_up();
          this.consume('code', regex[0].length);
          continue;
        }
      }
      if (js && char === '(') this.parens.push(this.classify_paren());
      if (js && char === ')') this.last_paren = this.parens.pop() ?? 'ambiguous';
      if (char === '{') depth++;
      if (char === '}' && depth) depth--;
      this.consume();
    }
  }
  /** What a `/` means here: a regex literal, a division, or either (the caller then lexes both). */
  private classify_slash(): Reading {
    const sig = this.last_sig;
    if (!sig) return 'regex';
    if (sig === ')') return this.last_paren;
    if (sig === ']') return 'division';
    if (sig === '}' || sig === '.' || sig === '/') return 'ambiguous';
    if (sig === '+' || sig === '-') return this.prev_sig === sig ? 'ambiguous' : 'regex'; // `a++ / b`
    if (sig === '!') return WORD.test(this.prev_sig) || ')]'.includes(this.prev_sig) ? 'ambiguous' : 'regex'; // `a! / b`
    if ('(,=:[&|?{};*%<>~^'.includes(sig)) return 'regex';
    if (WORD.test(sig)) {
      if (this.last_word_is_property) return 'division';
      if (REGEX_KEYWORDS.has(this.last_word)) return 'regex';
      return AMBIGUOUS_KEYWORDS.has(this.last_word) ? 'ambiguous' : 'division';
    }
    return 'division';
  }
  private classify_paren(): Reading {
    if (!WORD.test(this.last_sig) || this.last_word_is_property) return 'division';
    if (PAREN_KEYWORDS.has(this.last_word)) return 'regex';
    return this.last_word === 'await' ? 'ambiguous' : 'division'; // `for await (...) /re/`
  }
  /** Lexes the rest of the line from a throwaway copy, the `/` read as a regex of that length (0: as a division); the state it ends in. */
  private read_rest_of_line(regex_length: number, nested: boolean, depth: number): string {
    const fork: Lexer = Object.assign(Object.create(Lexer.prototype) as Lexer, this, { prose_lines: new Set(this.prose_lines), code_lines: new Set(this.code_lines), parens: [...this.parens], pending: [...this.pending], trial: true });
    if (regex_length) fork.consume('code', regex_length); else fork.consume();
    fork.scan_c(nested, depth);
    return [fork.pos, fork.last_sig, fork.last_word, fork.prev_sig, fork.last_word_is_property, fork.last_paren, fork.parens.join(), fork.trial_depth, fork.pending.length].join('|');
  }
  private scan_line_comment(): void {
    const spliced = C_FAMILY.has(this.extension); // in C and C++ a backslash before the newline continues the comment
    for (;;) {
      const start = this.pos;
      this.consume_to_line_end();
      if (!spliced || this.pos >= this.text.length || !/\\[ \t\r]*$/.test(this.text.slice(start, this.pos))) return;
      this.consume();
    }
  }
  private scan_c_word(): void {
    const extension = this.extension;
    const word = (C_FAMILY.has(extension) ? this.match(/(?:\d(?:\w|'(?=\w))*|[\w$]+)/y) : this.match(/[\w$]+/y))![0];
    const after = this.text[this.pos + word.length];
    if (extension === 'rs' && /^b?r$/.test(word) && (after === '"' || after === '#')) {
      const raw_string = this.match(/b?r(#*)"/y);
      if (raw_string) { this.consume('code', raw_string[0].length); this.scan_until(`"${raw_string[1]}`, false); return; }
    }
    if (C_FAMILY.has(extension) && /^(?:u8|u|U|L)?R$/.test(word) && after === '"') {
      const raw_string = this.match(/(?:u8|u|U|L)?R"([^()\\\s]{0,16})\(/y);
      if (raw_string) { this.consume('code', raw_string[0].length); this.scan_until(`)${raw_string[1]}"`, false); return; }
    }
    this.last_word = word;
    this.last_word_is_property = /\.\s*$/.test(this.text.slice(Math.max(0, this.pos - 8), this.pos));
    this.consume('code', word.length);
  }
  private scan_block_comment(): void {
    let level = 0;
    do {
      if (this.starts('/*')) { level++; this.consume('prose', 2); }
      else if (this.starts('*/')) { level--; this.consume('prose', 2); }
      else if (this.pos >= this.text.length) give_up();
      else this.consume('prose');
      if (!NESTED_COMMENTS.has(this.extension) && level > 1) level = 1;
    } while (level > 0);
  }
  private scan_template(): void {
    this.consume();
    for (;;) {
      if (this.pos >= this.text.length) give_up();
      if (this.text[this.pos] === '\\') this.consume('code', 2);
      else if (this.text[this.pos] === '`') { this.consume(); return; }
      else if (this.starts('${')) { this.consume('code', 2); this.scan_c(true); this.consume(); }
      else this.consume();
    }
  }

  // ---- ruby ----
  private scan_ruby(nested = false): void {
    let depth = 0;
    for (;;) {
      if (this.pos >= this.text.length) { if (nested) give_up(); return; }
      const char = this.text[this.pos]!;
      if (nested && char === '}' && !depth) return;
      if (this.is_line_start() && !nested) {
        if (/^=begin(?=\s|$)/.test(this.text.slice(this.pos, this.pos + 7))) { this.scan_begin_block(); continue; }
        if (/^__END__\s*(?:\n|$)/.test(this.text.slice(this.pos, this.pos + 12))) return;
      }
      if (char === '\n') { this.end_line(); continue; }
      if (/\s/.test(char)) { this.consume(); continue; }
      if (char === '#') { this.consume_to_line_end(); continue; }
      if (char === '$' && /["'/#]/.test(this.text[this.pos + 1] ?? '')) { this.consume('code', 2); continue; }
      if (WORD.test(char)) { const word = this.match(/[\w$]+[?!]?/y)![0]; this.last_word = word; this.consume('code', word.length); continue; }
      if (char === '"' || char === '`') { this.scan_simple_string(true, true); continue; }
      if (char === "'") { this.scan_simple_string(true); continue; }
      if (char === '?' && this.last_sig !== '' && !WORD.test(this.last_sig)) {
        const literal = this.match(/\?(?:\\.|[^\s\\])(?!\w)/y);
        if (literal) { this.consume('code', literal[0].length); continue; }
      }
      if (char === '<' && this.text[this.pos + 1] === '<' && this.text[this.pos + 2] !== '<') {
        const heredoc = this.match(/<<([~-]?)(?:(["'`])(\w+)\2|([A-Za-z_]\w*))/y);
        if (!heredoc && /<<[~-]["'`]/y.test(this.text.slice(this.pos, this.pos + 4))) give_up(); // a quoted id this lexer cannot read
        if (heredoc) { // any bare id counts: a wrongly read `a <<b` can only make the file give up or read more as code
          this.pending.push({ id: (heredoc[3] ?? heredoc[4])!, strip: !!heredoc[1] });
          this.consume('code', heredoc[0].length);
          continue;
        }
      }
      if (char === '%') {
        const literal = this.match(/%([qQwWiIrsx]?)([^\w\s=])/y);
        const before = this.text[this.pos - 1] ?? '';
        if (literal && (!this.last_sig || !(WORD.test(this.last_sig) || ')]}'.includes(this.last_sig)) || /\s/.test(before) && !/\s/.test(this.text[this.pos + 1] ?? ' '))) { this.scan_percent_literal(literal[2]!, literal[0].length); continue; }
      }
      if (char === '/') {
        const after = this.text[this.pos + 1] ?? ' ';
        if (!this.last_sig || !(WORD.test(this.last_sig) || ')]}\'"'.includes(this.last_sig)) || /\s/.test(this.text[this.pos - 1] ?? '') && !/[\s=]/.test(after)) {
          const regex = this.match(/\/(?:\\.|[^/\\\n])+\//y);
          if (!regex || regex[0].includes('#{')) return give_up(); // a multi-line /x regex or an interpolated one is not lexed
          this.consume('code', regex[0].length);
          continue;
        }
      }
      if (char === '{') depth++;
      if (char === '}' && depth) depth--;
      this.consume();
    }
  }
  private scan_percent_literal(open: string, length: number): void {
    const close = CLOSERS[open] ?? open;
    let level = 1;
    this.consume('code', length);
    while (level) {
      if (this.pos >= this.text.length) give_up();
      const char = this.text[this.pos]!;
      if (char === '\\') this.consume('code', 2);
      else { if (close !== open && char === open) level++; else if (char === close) level--; this.consume(); }
    }
  }
  private scan_begin_block(): void {
    for (;;) {
      const end = this.text.indexOf('\n', this.pos);
      const row = this.text.slice(this.pos, end < 0 ? undefined : end);
      const finished = /^=end(?=\s|$)/.test(row) && !row.startsWith('=begin');
      this.consume('prose', row.length);
      if (finished) return;
      if (end < 0) give_up();
      this.consume();
    }
  }

  /** Lines that hold prose and nothing else. */
  get_prose(): Set<number> { return new Set([...this.prose_lines].filter((line) => !this.code_lines.has(line))); }
}

/** The family a file extension belongs to; undefined when the lexer does not read it. */
const resolve_family = (extension: string): 'python' | 'c' | 'ruby' | undefined => extension === 'py' || extension === 'pyi' ? 'python' : extension === 'rb' ? 'ruby' : C_STYLE.has(extension) ? 'c' : undefined;

/**
 * The 0-based lines wholly inside a block comment (`/* *\/`, nested in Rust, Kotlin, Swift and Scala; `=begin`/`=end` at
 * column 0 in Ruby) or a Python docstring (a triple-quoted statement that is the first of the module or follows a def or
 * class header). String data (after `return`, `=`, `(`, `:`, `+`, `,`, a template literal, a raw_string string, a heredoc) is
 * never prose. An unknown extension, an unterminated construct or anything unclassifiable marks nothing.
 */
export function find_block_lines(text: string, file?: string): Set<number> {
  const extension = file ? /\.(\w+)$/.exec(file)?.[1]?.toLowerCase() ?? '' : '';
  const family = resolve_family(extension);
  if (!family || !PARSER_CHECKED.has(extension)) return new Set();
  if (JS_EXTENSIONS.has(extension) && /<!--|^[ \t]*-->/m.test(text)) return new Set(); // a classic-script HTML comment opener
  if (extension === 'php' && (!/^(?:\uFEFF)?(?:#![^\n]*\n)?\s*<\?/.test(text) || /\?>\s*\S/.test(text))) return new Set(); // inline HTML is text this lexer does not read
  if (extension === 'jsx' || extension === 'tsx') return new Set(); // JSX text is not lexed
  if (family === 'c' && !JS_EXTENSIONS.has(extension) && extension !== 'php' && /^\uFEFF?#!/.test(text)) return new Set(); // a hashbang line is only a comment in JS
  if (C_FAMILY.has(extension) && /__has_include|\?\?\/|^[ \t]*(?:export[ \t]+)?import[ \t]*<|\/\\[ \t]*\r?\n[*/]|\*\\[ \t]*\r?\n\//m.test(text)) return new Set(); // header units, trigraphs and a splice inside a comment mark
  try {
    const lexer = new Lexer(text, extension, family);
    lexer.run();
    return lexer.get_prose();
  } catch { return new Set(); }
}

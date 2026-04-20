// When-clause evaluator.
//
// Mini language for command visibility predicates. Whitelist-only — we do
// NOT support arbitrary property access. Grammar:
//
//   expr   := or
//   or     := and ('||' and)*
//   and    := not ('&&' not)*
//   not    := '!' not | atom
//   atom   := token | '(' expr ')'
//   token  := 'focusedIs.file' | 'focusedIs.folder' | 'focusedIs.root'
//           | 'hasSelection' | 'isMultiSelect' | 'isRenaming'
//
// Unknown tokens throw a descriptive error so typos surface at registration
// time rather than at dispatch.
//
// Function-form `when` is evaluated as-is (escape hatch for complex logic).

import type { Entry } from '@vibecook/mille';
import type { CommandContext } from './types.js';

// Local mirror of api.d.ts `EntryKind`. The engine ships `entry.kind` as a
// plain `number` in the public types, so we keep our own numeric constants
// rather than importing a non-exported enum. Values match api.d.ts §EntryKind.
const KIND_FILE = 0;
const KIND_DIRECTORY = 1;

const KNOWN_TOKENS = new Set<string>([
  'focusedIs.file',
  'focusedIs.folder',
  'focusedIs.root',
  'hasSelection',
  'isMultiSelect',
  'isRenaming',
]);

/**
 * Evaluate the when clause against `ctx`. `true` when the command should be
 * shown / enabled; `false` otherwise. If `clause` is `undefined`, returns
 * `true` (no clause = always visible).
 */
export function evaluateWhen(
  clause: string | ((ctx: CommandContext) => boolean) | undefined,
  ctx: CommandContext,
): boolean {
  if (clause === undefined) return true;
  if (typeof clause === 'function') return Boolean(clause(ctx));
  const tokens = tokenize(clause);
  const parser = new Parser(tokens, clause);
  const ast = parser.parseExpr();
  parser.expectEnd();
  return evalNode(ast, ctx);
}

// ─── Tokenization ──────────────────────────────────────────────────────────

type Token =
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'and' }
  | { readonly kind: 'or' }
  | { readonly kind: 'not' }
  | { readonly kind: 'lparen' }
  | { readonly kind: 'rparen' };

function tokenize(input: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === undefined) break;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (ch === '!') { tokens.push({ kind: 'not' }); i++; continue; }
    if (ch === '&') {
      if (input[i + 1] !== '&') {
        throw new Error(`evaluateWhen: expected '&&' at position ${i} in "${input}"`);
      }
      tokens.push({ kind: 'and' });
      i += 2;
      continue;
    }
    if (ch === '|') {
      if (input[i + 1] !== '|') {
        throw new Error(`evaluateWhen: expected '||' at position ${i} in "${input}"`);
      }
      tokens.push({ kind: 'or' });
      i += 2;
      continue;
    }
    if (/[A-Za-z_.]/.test(ch)) {
      const start = i;
      while (i < input.length) {
        const c = input[i];
        if (c === undefined) break;
        if (!/[A-Za-z0-9_.]/.test(c)) break;
        i++;
      }
      const value = input.slice(start, i);
      tokens.push({ kind: 'id', value });
      continue;
    }
    throw new Error(`evaluateWhen: unexpected character '${ch}' at position ${i} in "${input}"`);
  }
  return tokens;
}

// ─── Parsing ───────────────────────────────────────────────────────────────

type Node =
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'and'; readonly left: Node; readonly right: Node }
  | { readonly kind: 'or'; readonly left: Node; readonly right: Node }
  | { readonly kind: 'not'; readonly expr: Node };

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  parseExpr(): Node {
    return this.parseOr();
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek()?.kind === 'or') {
      this.advance();
      const right = this.parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.peek()?.kind === 'and') {
      this.advance();
      const right = this.parseNot();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.peek()?.kind === 'not') {
      this.advance();
      return { kind: 'not', expr: this.parseNot() };
    }
    return this.parseAtom();
  }

  private parseAtom(): Node {
    const tok = this.peek();
    if (tok === undefined) {
      throw new Error(`evaluateWhen: unexpected end of expression in "${this.source}"`);
    }
    if (tok.kind === 'lparen') {
      this.advance();
      const node = this.parseOr();
      const close = this.peek();
      if (close?.kind !== 'rparen') {
        throw new Error(`evaluateWhen: expected ')' in "${this.source}"`);
      }
      this.advance();
      return node;
    }
    if (tok.kind === 'id') {
      if (!KNOWN_TOKENS.has(tok.value)) {
        throw new Error(
          `evaluateWhen: unknown token "${tok.value}" in "${this.source}". Allowed: ${Array.from(KNOWN_TOKENS).join(', ')}`,
        );
      }
      this.advance();
      return { kind: 'id', value: tok.value };
    }
    throw new Error(`evaluateWhen: unexpected token in "${this.source}"`);
  }

  expectEnd(): void {
    if (this.pos !== this.tokens.length) {
      throw new Error(`evaluateWhen: trailing input in "${this.source}"`);
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): void {
    this.pos++;
  }
}

// ─── Evaluation ────────────────────────────────────────────────────────────

function evalNode(node: Node, ctx: CommandContext): boolean {
  switch (node.kind) {
    case 'id': return evalToken(node.value, ctx);
    case 'and': return evalNode(node.left, ctx) && evalNode(node.right, ctx);
    case 'or':  return evalNode(node.left, ctx) || evalNode(node.right, ctx);
    case 'not': return !evalNode(node.expr, ctx);
  }
}

function evalToken(token: string, ctx: CommandContext): boolean {
  switch (token) {
    case 'focusedIs.file':
      return isKind(ctx.focusedEntry, KIND_FILE);
    case 'focusedIs.folder':
      return isKind(ctx.focusedEntry, KIND_DIRECTORY);
    case 'focusedIs.root':
      return ctx.focusedEntry !== null && ctx.focusedEntry.parentId === null;
    case 'hasSelection':
      return ctx.selectedIds.size > 0;
    case 'isMultiSelect':
      return ctx.isMultiSelect;
    case 'isRenaming':
      return ctx.isRenaming;
    default:
      // Unreachable — parser rejects unknown tokens.
      throw new Error(`evaluateWhen: internal error — unknown token "${token}"`);
  }
}

function isKind(entry: Entry | null, kind: number): boolean {
  return entry !== null && entry.kind === kind;
}

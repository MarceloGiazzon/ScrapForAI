/**
 * T5.5: a small, safe expression language for "what SHOULD the page show?". Pure: no configuration, no I/O, and no `eval`/`Function`:
 * the text is tokenized and parsed by hand into a tree, and the tree is walked. Nothing in it can reach the host.
 *
 *   numbers      12  12.5  .5
 *   variables    price qty tax_rate        (letters, digits, underscore; not starting with a digit)
 *   operators    + - * / ^  (^ is right-associative and binds tighter than unary minus: -2^2 = -4, 2^3^2 = 512)
 *   comparison   < <= > >= == !=   and   && || !      (true is 1, false is 0)
 *   functions    round(x) round(x, digits)  floor(x)  ceil(x)  abs(x)  min(a, ...)  max(a, ...)  if(cond, a, b)
 *
 * `round` is half away from zero ("commercial": round(2.5) = 3, round(-2.5) = -3, round(1.005, 2) = 1.01), after dropping floating-point noise.
 * `if` evaluates only the branch it takes, so `if(qty == 0, 0, total / qty)` never divides by zero.
 * Every arithmetic result is cleaned to 15 significant digits, so 0.1 + 0.2 is 0.3. Division by zero and any non-finite result are errors.
 */

export class ExpressionError extends Error {
  constructor(
    readonly type: 'ExpressionSyntax' | 'ExpressionEval',
    message: string,
  ) {
    super(message);
    this.name = type;
  }
}

export const MAX_EXPRESSION_CHARS = 500;
const MAX_DEPTH = 60;

type Token = { kind: 'num' | 'id' | 'op' | 'end'; text: string; pos: number };

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '^', '(', ')', ',', '<', '>', '!'];

function tokenize(source: string): Token[] {
  if (source.length > MAX_EXPRESSION_CHARS) throw new ExpressionError('ExpressionSyntax', `expression longer than ${MAX_EXPRESSION_CHARS} characters`);
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < source.length) {
    const rest = source.slice(pos);
    const space = /^\s+/.exec(rest);
    if (space) {
      pos += space[0].length;
      continue;
    }
    const num = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest);
    if (num) {
      tokens.push({ kind: 'num', text: num[0], pos });
      pos += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (id) {
      tokens.push({ kind: 'id', text: id[0], pos });
      pos += id[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (!op) throw new ExpressionError('ExpressionSyntax', `unexpected character "${rest[0]}" at position ${pos}`);
    tokens.push({ kind: 'op', text: op, pos });
    pos += op.length;
  }
  tokens.push({ kind: 'end', text: '', pos: source.length });
  return tokens;
}

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'un'; op: '-' | '+' | '!'; a: Expr }
  | { t: 'bin'; op: string; a: Expr; b: Expr }
  | { t: 'call'; fn: string; args: Expr[] };

/** name -> [min arguments, max arguments]. */
const FUNCTIONS: Record<string, [number, number]> = {
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  abs: [1, 1],
  min: [1, 20],
  max: [1, 20],
  if: [3, 3],
};

export function parseExpression(source: string): Expr {
  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;

  const peek = (): Token => tokens[index]!;
  const isOp = (text: string): boolean => peek().kind === 'op' && peek().text === text;
  const fail = (message: string): never => {
    throw new ExpressionError('ExpressionSyntax', `${message} at position ${peek().pos}`);
  };
  const expect = (text: string): void => {
    if (!isOp(text)) fail(`expected "${text}"${peek().kind === 'end' ? ' but the expression ended' : ` but found "${peek().text}"`}`);
    index += 1;
  };
  const nested = <T>(parse: () => T): T => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new ExpressionError('ExpressionSyntax', 'expression nested too deeply');
    try {
      return parse();
    } finally {
      depth -= 1;
    }
  };

  const binary = (ops: string[], next: () => Expr): (() => Expr) => () => {
    let left = next();
    while (peek().kind === 'op' && ops.includes(peek().text)) {
      const op = tokens[index++]!.text;
      left = { t: 'bin', op, a: left, b: next() };
    }
    return left;
  };

  function primary(): Expr {
    const token = peek();
    if (token.kind === 'num') {
      index += 1;
      return { t: 'num', v: Number(token.text) };
    }
    if (token.kind === 'id') {
      index += 1;
      if (!isOp('(')) return { t: 'var', name: token.text };
      const arity = FUNCTIONS[token.text];
      if (!arity) throw new ExpressionError('ExpressionSyntax', `unknown function "${token.text}" (known: ${Object.keys(FUNCTIONS).join(', ')})`);
      index += 1;
      const args: Expr[] = [];
      if (!isOp(')')) {
        args.push(nested(or));
        while (isOp(',')) {
          index += 1;
          args.push(nested(or));
        }
      }
      expect(')');
      if (args.length < arity[0] || args.length > arity[1]) {
        throw new ExpressionError('ExpressionSyntax', `${token.text}() takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} argument(s), got ${args.length}`);
      }
      return { t: 'call', fn: token.text, args };
    }
    if (isOp('(')) {
      index += 1;
      const inner = nested(or);
      expect(')');
      return inner;
    }
    return fail(token.kind === 'end' ? 'the expression ended too early' : `unexpected "${token.text}"`);
  }

  function power(): Expr {
    const base = primary();
    if (isOp('^')) {
      index += 1;
      return { t: 'bin', op: '^', a: base, b: nested(unary) }; // right-associative; 2^-1 is fine
    }
    return base;
  }

  function unary(): Expr {
    if (isOp('-') || isOp('+') || isOp('!')) {
      const op = tokens[index++]!.text as '-' | '+' | '!';
      return { t: 'un', op, a: nested(unary) };
    }
    return power();
  }

  const mul = binary(['*', '/'], unary);
  const add = binary(['+', '-'], mul);
  const rel = binary(['<', '<=', '>', '>='], add);
  const eq = binary(['==', '!='], rel);
  const and = binary(['&&'], eq);
  function or(): Expr {
    return binary(['||'], and)();
  }

  const tree = or();
  if (peek().kind !== 'end') fail(`unexpected "${peek().text}"`);
  return tree;
}

/** Names the expression reads, in order of first use. */
export function variablesOf(tree: Expr): string[] {
  const found = new Set<string>();
  const walk = (node: Expr): void => {
    switch (node.t) {
      case 'var':
        found.add(node.name);
        break;
      case 'un':
        walk(node.a);
        break;
      case 'bin':
        walk(node.a);
        walk(node.b);
        break;
      case 'call':
        node.args.forEach(walk);
        break;
      default:
        break;
    }
  };
  walk(tree);
  return [...found];
}

/** Rewrites variable names in the SOURCE text (functions and everything else untouched). Used when an included routine's parameters are renamed. */
export function renameVariables(source: string, names: ReadonlyMap<string, string>): string {
  const tokens = tokenize(source);
  let out = '';
  let last = 0;
  tokens.forEach((token, i) => {
    if (token.kind !== 'id') return;
    const renamed = names.get(token.text);
    const isCall = tokens[i + 1]?.kind === 'op' && tokens[i + 1]!.text === '(';
    if (renamed === undefined || isCall) return;
    out += source.slice(last, token.pos) + renamed;
    last = token.pos + token.text.length;
  });
  return out + source.slice(last);
}

const clean = (value: number): number => (Number.isFinite(value) ? Number(value.toPrecision(15)) : value);

/** Half away from zero, on the decimal text so that 1.005 -> 1.01 (binary 1.005 is 1.00499999...). */
export function roundHalfAway(value: number, digits = 0): number {
  const cleaned = clean(value);
  const abs = Math.abs(cleaned);
  const text = String(abs);
  const scaled = text.includes('e') ? abs * 10 ** digits : Number(`${text}e${digits}`);
  const rounded = Math.round(scaled); // Math.round rounds .5 up, which for a magnitude is "away from zero"
  const back = text.includes('e') ? rounded / 10 ** digits : Number(`${rounded}e${-digits}`);
  return cleaned < 0 ? -back : back;
}

export function evaluateExpression(tree: Expr, lookup: (name: string) => number): number {
  const check = (value: number, what: string): number => {
    if (!Number.isFinite(value)) throw new ExpressionError('ExpressionEval', `${what} is not a finite number`);
    return value;
  };

  const run = (node: Expr): number => {
    switch (node.t) {
      case 'num':
        return node.v;
      case 'var':
        return check(lookup(node.name), `variable "${node.name}"`);
      case 'un': {
        const value = run(node.a);
        return node.op === '-' ? -value : node.op === '+' ? value : value === 0 ? 1 : 0;
      }
      case 'bin': {
        if (node.op === '&&') return run(node.a) !== 0 && run(node.b) !== 0 ? 1 : 0;
        if (node.op === '||') return run(node.a) !== 0 || run(node.b) !== 0 ? 1 : 0;
        const a = run(node.a);
        const b = run(node.b);
        switch (node.op) {
          case '+':
            return clean(a + b);
          case '-':
            return clean(a - b);
          case '*':
            return check(clean(a * b), 'a product');
          case '/':
            if (b === 0) throw new ExpressionError('ExpressionEval', 'division by zero');
            return clean(a / b);
          case '^':
            return check(clean(a ** b), `${a}^${b}`);
          case '<':
            return a < b ? 1 : 0;
          case '<=':
            return a <= b ? 1 : 0;
          case '>':
            return a > b ? 1 : 0;
          case '>=':
            return a >= b ? 1 : 0;
          case '==':
            return a === b ? 1 : 0;
          case '!=':
            return a !== b ? 1 : 0;
          default:
            throw new ExpressionError('ExpressionEval', `unknown operator ${node.op}`);
        }
      }
      case 'call': {
        if (node.fn === 'if') return run(node.args[0]!) !== 0 ? run(node.args[1]!) : run(node.args[2]!);
        const args = node.args.map(run);
        switch (node.fn) {
          case 'round': {
            const digits = args[1] ?? 0;
            if (!Number.isInteger(digits) || digits < 0 || digits > 10) throw new ExpressionError('ExpressionEval', 'round(): digits must be an integer from 0 to 10');
            return roundHalfAway(args[0]!, digits);
          }
          case 'floor':
            return Math.floor(clean(args[0]!));
          case 'ceil':
            return Math.ceil(clean(args[0]!));
          case 'abs':
            return Math.abs(args[0]!);
          case 'min':
            return Math.min(...args);
          case 'max':
            return Math.max(...args);
          default:
            throw new ExpressionError('ExpressionEval', `unknown function ${node.fn}`);
        }
      }
    }
  };

  return check(run(tree), 'the result');
}

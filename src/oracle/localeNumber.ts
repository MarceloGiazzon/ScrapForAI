/**
 * T5.5: numbers as a page prints them. Pure.
 *
 * `1.234,56` and `1,234.56` are the same number in two conventions, and `1.234` is either one thousand two hundred thirty-four or 1.234
 * depending on the convention, so the locale is never guessed: the caller says which one the page uses.
 *   en  group ","  decimal "."   (1,234.56)
 *   pt  group "."  decimal ","   (1.234,56)     Brazilian Portuguese
 *   es  group "."  decimal ","   (1.234,56)     Spanish as written in Uruguay and Spain
 * A currency symbol or code (R$, $, U$S, EUR, %) before or after the digits, spaces (also non-breaking) and a leading minus (or a
 * minus sign, or accounting parentheses) are accepted; anything else is an error, never a silent 0.
 */

export type NumberLocale = 'en' | 'pt' | 'es';

export const NUMBER_LOCALES: readonly NumberLocale[] = ['en', 'pt', 'es'];

const SEPARATORS: Record<NumberLocale, { group: string; decimal: string }> = {
  en: { group: ',', decimal: '.' },
  pt: { group: '.', decimal: ',' },
  es: { group: '.', decimal: ',' },
};

export class NumberParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotANumber';
  }
}

const escape = (text: string): string => text.replace(/[.,]/g, (character) => `\\${character}`);

export function parseLocaleNumber(input: string, locale: NumberLocale = 'en'): number {
  const { group, decimal } = SEPARATORS[locale];
  const fail = (): never => {
    throw new NumberParseError(`"${input.length > 40 ? `${input.slice(0, 40)}…` : input}" is not a number in the "${locale}" format (group "${group}", decimal "${decimal}")`);
  };
  // A space between digit groups of three is a thousands separator ("1 234,56"); any other space between digits is not a number.
  let text = input.replace(/(\d)[\s   ](?=\d{3}(?!\d))/g, '$1');
  if (/\d[\s   ]+\d/.test(text)) fail();
  text = text.replace(/[\s   ]+/g, '');
  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  const sign = /^([+\-−])/.exec(text);
  if (sign) {
    negative = negative || sign[1] !== '+';
    text = text.slice(1);
  }
  // One currency symbol (R$, U$S, $, EUR...) or a percent sign before or after the digits; any other letters are an error below.
  const withoutLeadingSymbol = text.replace(/^(?:R\$|U\$S|[$€£¥]|[A-Z]{3})/, '');
  const hadLeadingSymbol = withoutLeadingSymbol !== text;
  text = withoutLeadingSymbol.replace(/(?:R\$|U\$S|[$€£¥%]|[A-Z]{3})$/, '');
  // "R$ -3,00": the sign may follow the symbol, but only one sign in all.
  const afterSymbolSign = hadLeadingSymbol ? /^([+\-−])/.exec(text) : null;
  if (afterSymbolSign) {
    negative = negative || afterSymbolSign[1] !== '+';
    text = text.slice(1);
  }

  const shape = new RegExp(`^(?:\\d{1,3}(?:${escape(group)}\\d{3})+|\\d+)(?:${escape(decimal)}\\d+)?$|^${escape(decimal)}\\d+$`);
  if (!shape.test(text)) fail();

  const value = Number(text.split(group).join('').replace(decimal, '.'));
  return negative ? -value : value;
}

/** Parameter values are generated, not typed on a page: always plain `-12.5` (digits, an optional dot and sign), whatever the locale. */
export function parseInvariantNumber(input: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(input)) {
    throw new NumberParseError(`"${input.length > 40 ? `${input.slice(0, 40)}…` : input}" is not a plain number (digits with an optional "." and sign)`);
  }
  return Number(input);
}

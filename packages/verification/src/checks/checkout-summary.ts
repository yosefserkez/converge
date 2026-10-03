import { header } from '../app-client.ts';
import { CUSTOMER_IDS, EXPECTATIONS, expectedUnitPrice, formatCents, listPrice } from '../expectations.ts';
import type { CheckImpl } from './context.ts';

const LABEL_GAP = '[^$\\d]{0,40}';

/**
 * Label-to-value patterns over the visible text. `{v}` is the escaped
 * formatted value. Labels accept common wording; values must be exact.
 */
export const CHECKOUT_PATTERNS = {
  listPrice: `(list|regular|original)\\s+price${LABEL_GAP}{v}`,
  unitPrice: `(unit\\s+price|price\\s+(each|per\\s+(item|unit)))${LABEL_GAP}{v}`,
  quantity: `(quantity|qty)${LABEL_GAP}{v}(?!\\d)`,
  total: `\\btotal${LABEL_GAP}{v}`,
  savings: `\\bsav(e|es|ings)\\b${LABEL_GAP}{v}`,
  savingsWord: `\\bsav(e|es|ings)\\b`,
  brokenValue: `\\b(NaN|undefined|null)\\b|\\[object Object\\]`,
} as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pattern(source: string, value?: string): RegExp {
  return new RegExp(value === undefined ? source : source.replace('{v}', escapeRegExp(value)), 'i');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Visible text of the rendered page: no scripts, styles, or tags; collapsed whitespace. */
export function visibleText(html: string): string {
  const withoutCode = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  return decodeEntities(withoutCode.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** A container labelled by aria-label, or by aria-labelledby that points at an existing id. */
export function hasLabelledRegion(html: string): boolean {
  if (/\saria-label="[^"]*\S[^"]*"/i.test(html)) return true;
  for (const match of html.matchAll(/\saria-labelledby="([^"]+)"/gi)) {
    const ids = (match[1] ?? '').split(/\s+/).filter(Boolean);
    if (ids.length > 0 && ids.every((id) => html.includes(`id="${id}"`))) return true;
  }
  return false;
}

/** The breakdown uses a definition list (at least four terms) or a table with header cells. */
export function hasStructuredBreakdown(html: string): boolean {
  const terms = html.match(/<dt\b/gi)?.length ?? 0;
  const definitions = html.match(/<dd\b/gi)?.length ?? 0;
  if (/<dl\b/i.test(html) && terms >= 4 && definitions >= 4) return true;
  return /<table\b/i.test(html) && (html.match(/<th\b/gi)?.length ?? 0) >= 4;
}

export const checkoutSummary: CheckImpl = async ({ rec, pool, capabilities }) => {
  const { productId, quantity } = EXPECTATIONS.checkout;
  for (const customerId of CUSTOMER_IDS) {
    await pool.withFresh(async (app) => {
      const label = `${customerId} ${productId} q${quantity}`;
      const response = await app.request({
        method: 'GET',
        path: `/__render/checkout?productId=${productId}&quantity=${quantity}`,
        headers: { 'x-demo-customer': customerId },
      });
      rec.equal(`${label} status`, 200, response.status);
      rec.check(`${label} content-type`, 'text/html', header(response, 'content-type'), header(response, 'content-type').startsWith('text/html'));
      rec.check(`${label} cache-control`, 'no-store', header(response, 'cache-control'), /\bno-store\b/.test(header(response, 'cache-control')));

      const html = response.bodyText;
      const text = visibleText(html);
      const unit = expectedUnitPrice(productId, customerId, capabilities);
      const list = listPrice(productId);
      const savings = list - unit;
      const shows = (name: string, source: string, value: string) =>
        rec.check(`${label} shows ${name}`, `${name} ${value}`, text, pattern(source, value).test(text));

      shows('list price', CHECKOUT_PATTERNS.listPrice, formatCents(list));
      shows('unit price', CHECKOUT_PATTERNS.unitPrice, formatCents(unit));
      shows('quantity', CHECKOUT_PATTERNS.quantity, String(quantity));
      shows('total', CHECKOUT_PATTERNS.total, formatCents(unit * quantity));
      if (savings > 0) {
        shows('member savings', CHECKOUT_PATTERNS.savings, formatCents(savings));
      } else {
        rec.check(`${label} hides savings when savingsCents is 0`, 'no savings line', text, !pattern(CHECKOUT_PATTERNS.savingsWord).test(text));
      }
      rec.check(`${label} no broken values`, 'no NaN, undefined, null, or [object Object]', text, !pattern(CHECKOUT_PATTERNS.brokenValue).test(text));
      rec.check(`${label} labelled summary region`, 'aria-label or resolvable aria-labelledby', html, hasLabelledRegion(html));
      rec.check(`${label} structured breakdown`, '<dl> with 4+ <dt>/<dd> pairs, or <table> with 4+ <th>', html, hasStructuredBreakdown(html));
    });
  }
};

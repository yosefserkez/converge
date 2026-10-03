// Protected HTTP transport and bootstrap for the synthetic storefront.
//
// Routes:
//   GET  /healthz                         readiness probe
//   POST /api/quote                       {productId, quantity}; customer from X-Demo-Customer
//   GET  /__render/checkout?productId&quantity   server-rendered CheckoutSummary (verifier)
//   GET  /__diagnostics/compute-count     {count} of real pricing computations (verifier only;
//                                         public preview routing blocks /__* paths)
//   GET  /, /client.js, /client.css       browser app
//
// Errors: 400 malformed JSON, 401 missing or unknown X-Demo-Customer, 413 body
// over 4 KiB, 422 unknown product or quantity outside integers 1..20.
// X-Demo-Customer is a synthetic fixture selector, NOT production authentication.
// The server never accepts a price from the client: it reads only productId and
// quantity from the body.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolveCustomer, type CustomerContext } from './customer-fixtures';
import { countCalls, getComputeCount } from './diagnostics';
import { getProduct } from './products';
import { computeUnitPrice } from './pricing/compute-unit-price';
import { createUnitPriceCache } from './pricing/quote-cache';
import { isValidQuantity, validateQuote, type Quote } from './quote-contract';
import { renderCheckoutPage } from './render';

const MAX_BODY_BYTES = 4096;

// The compute counter wraps the pricing function OUTSIDE the agent-editable
// cache module, so a cache that is bypassed or never hit is observable.
const counted = countCalls(computeUnitPrice);
const getUnitPrice = createUnitPriceCache(counted);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    return Promise.reject(new HttpError(413, 'body_too_large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new HttpError(413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!rejected) reject(new HttpError(400, 'body_read_failed'));
    });
  });
}

function requireCustomer(req: IncomingMessage): CustomerContext {
  const header = req.headers['x-demo-customer'];
  const customer = resolveCustomer(typeof header === 'string' ? header : undefined);
  if (!customer) throw new HttpError(401, 'unknown_customer');
  return customer;
}

function buildQuote(productId: unknown, quantity: unknown, customer: CustomerContext): Quote {
  if (typeof productId !== 'string' || !getProduct(productId)) throw new HttpError(422, 'unknown_product');
  if (!isValidQuantity(quantity)) throw new HttpError(422, 'invalid_quantity');
  const { listPriceCents, unitPriceCents } = getUnitPrice({ productId, customer });
  const quote: Quote = {
    productId,
    listPriceCents,
    unitPriceCents,
    savingsCents: listPriceCents - unitPriceCents,
    quantity,
    totalCents: unitPriceCents * quantity,
    currency: 'USD',
  };
  const problems = validateQuote(quote);
  if (problems.length > 0) throw new HttpError(500, 'invalid_quote');
  return quote;
}

async function handleQuote(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'malformed_json');
  }
  const customer = requireCustomer(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(422, 'invalid_body');
  const { productId, quantity } = body as Record<string, unknown>;
  sendJson(res, 200, buildQuote(productId, quantity, customer));
}

function handleRender(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const customer = requireCustomer(req);
  const quantityParam = url.searchParams.get('quantity') ?? '';
  const quantity = /^\d{1,3}$/.test(quantityParam) ? Number(quantityParam) : Number.NaN;
  const quote = buildQuote(url.searchParams.get('productId'), quantity, customer);
  send(res, 200, 'text/html; charset=utf-8', renderCheckoutPage(quote));
}

async function sendAsset(res: ServerResponse, relative: string, contentType: string): Promise<void> {
  try {
    send(res, 200, contentType, await readFile(new URL(relative, import.meta.url)));
  } catch {
    throw new HttpError(404, 'not_found');
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const key = `${req.method ?? 'GET'} ${url.pathname}`;
  switch (key) {
    case 'GET /healthz':
      return sendJson(res, 200, { ok: true });
    case 'POST /api/quote':
      return handleQuote(req, res);
    case 'GET /__render/checkout':
      return handleRender(req, res, url);
    case 'GET /__diagnostics/compute-count':
      return sendJson(res, 200, { count: getComputeCount() });
    case 'GET /':
    case 'GET /index.html':
      // Paths resolve relative to the bundle at dist/server.mjs.
      return sendAsset(res, '../public/index.html', 'text/html; charset=utf-8');
    case 'GET /client.js':
      return sendAsset(res, './client.js', 'text/javascript; charset=utf-8');
    case 'GET /client.css':
      return sendAsset(res, './client.css', 'text/css; charset=utf-8');
    default:
      throw new HttpError(url.pathname === '/api/quote' ? 405 : 404, url.pathname === '/api/quote' ? 'method_not_allowed' : 'not_found');
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const code = err instanceof HttpError ? err.code : 'internal_error';
    if (status === 413) res.setHeader('connection', 'close');
    if (!res.headersSent) sendJson(res, status, { error: code });
    else res.end();
  });
});

const port = Number(process.env.PORT ?? '8080');
server.listen(Number.isInteger(port) && port > 0 ? port : 8080, '0.0.0.0', () => {
  console.log(`storefront listening on ${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

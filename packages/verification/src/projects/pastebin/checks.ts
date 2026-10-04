import { header } from '../../app-client.ts';
import { visibleText } from '../../checks/checkout-summary.ts';
import type { CheckImpl } from '../../checks/context.ts';
import type { Recorder } from '../../recorder.ts';
import type { AppInstance, AppResponse } from '../../types.ts';
import { byteLength, cacheControl, cleanup, field, get, head, maxAge, readMeta, rolePath, upload, type UploadCall } from './client.ts';
import { PASTEBIN_EXPECTATIONS as X } from './expectations.ts';

const { statuses } = X;

/** Records the upload status and paste path. Returns the path, or null when the check cannot go on. */
function uploaded(rec: Recorder, label: string, call: UploadCall): string | null {
  rec.equal(`${label} upload status`, statuses.ok, call.response.status);
  rec.check(`${label} upload returns a paste url`, 'absolute URL with a paste path', field(call.json, 'url') ?? null, call.path !== null);
  return call.response.status === statuses.ok ? call.path : null;
}

function noStore(response: AppResponse): boolean {
  const value = cacheControl(response);
  return /\bno-store\b/i.test(value) && !/\bpublic\b/i.test(value);
}

function isStrongEtag(value: string): boolean {
  return /^"[\x21\x23-\x7e]+"$/.test(value);
}

/**
 * Upload, read, HEAD, metadata, and delete of an unlimited paste. Content and
 * status codes must match the upstream behavior.
 */
export const pasteRoundtrip: CheckImpl = async ({ rec, pool }) => {
  await pool.withFresh(async (app) => {
    const content = X.contents.roundtrip;
    const call = await upload(app, { c: content });
    const path = uploaded(rec, 'roundtrip', call);
    if (path === null) return;
    rec.check('upload content-type', 'application/json', header(call.response, 'content-type'), header(call.response, 'content-type').startsWith('application/json'));
    rec.equal('upload sizeBytes', byteLength(content), field(call.json, 'sizeBytes') ?? null);
    rec.equal('upload expirationSeconds', X.expirationSeconds, field(call.json, 'expirationSeconds') ?? null);
    rec.check('upload returns a manage url', 'URL with name:password', field(call.json, 'manageUrl') ?? null, call.managePath?.includes(':') === true);

    for (const attempt of [1, 2]) {
      const read = await get(app, path);
      rec.equal(`read ${attempt} status`, statuses.ok, read.status);
      rec.equal(`read ${attempt} body`, content, read.bodyText);
      rec.check(`read ${attempt} content-type`, 'text/plain', header(read, 'content-type'), header(read, 'content-type').startsWith('text/plain'));
    }

    const headResponse = await head(app, path);
    rec.equal('HEAD status', statuses.ok, headResponse.status);
    rec.equal('HEAD content-length', String(byteLength(content)), header(headResponse, 'content-length'));
    rec.equal('HEAD body', '', headResponse.bodyText);

    const meta = await readMeta(app, path);
    rec.equal('metadata status', statuses.ok, meta.response.status);
    rec.equal('metadata sizeBytes', byteLength(content), field(meta.json, 'sizeBytes') ?? null);
    rec.equal('metadata location', 'KV', field(meta.json, 'location') ?? null);

    if (call.managePath === null) return;
    const deleted = await app.request({ method: 'DELETE', path: call.managePath });
    rec.equal('delete status', statuses.ok, deleted.status);
    rec.equal('read after delete status', statuses.notFound, (await get(app, path)).status);
    rec.equal('metadata after delete status', statuses.notFound, (await readMeta(app, path)).response.status);
    rec.equal('missing paste status', statuses.notFound, (await get(app, `/${X.missingName}`)).status);
  });
};

/**
 * views=2: two content reads succeed and the third is 404. HEAD and metadata
 * reads do not use a view. An unlimited paste keeps working, and invalid
 * views values get 400.
 */
export const viewsLimit: CheckImpl = async ({ rec, pool }) => {
  await pool.withFresh(async (app) => {
    const content = X.contents.limit;
    const views = X.limitViews;
    const call = await upload(app, { c: content, views: String(views) });
    const path = uploaded(rec, 'limited', call);
    if (path === null) return;
    rec.equal('upload maxViews', views, field(call.json, 'maxViews') ?? null);
    rec.equal('upload viewsRemaining', views, field(call.json, 'viewsRemaining') ?? null);

    rec.equal('HEAD status', statuses.ok, (await head(app, path)).status);
    const before = await readMeta(app, path);
    rec.equal('metadata status before reads', statuses.ok, before.response.status);
    rec.equal('viewsRemaining after HEAD and metadata reads', views, field(before.json, 'viewsRemaining') ?? null);

    for (let n = 1; n <= views; n += 1) {
      const read = await get(app, path);
      rec.equal(`read ${n} of ${views} status`, statuses.ok, read.status);
      rec.equal(`read ${n} of ${views} body`, content, read.bodyText);
      if (n < views) {
        const meta = await readMeta(app, path);
        rec.equal(`viewsRemaining after read ${n}`, views - n, field(meta.json, 'viewsRemaining') ?? null);
      }
    }
    const extra = await get(app, path);
    rec.equal(`read ${views + 1} status (limit reached)`, statuses.notFound, extra.status);
    rec.check(`read ${views + 1} does not return the content`, 'no paste content', extra.bodyText, !extra.bodyText.includes(content));
    rec.equal('metadata status after the last view', statuses.notFound, (await readMeta(app, path)).response.status);

    const plain = await upload(app, { c: X.contents.unlimited });
    const plainPath = uploaded(rec, 'unlimited', plain);
    if (plainPath !== null) {
      for (const n of [1, 2, 3]) rec.equal(`unlimited read ${n} status`, statuses.ok, (await get(app, plainPath)).status);
      const meta = await readMeta(app, plainPath);
      rec.equal('unlimited metadata has no viewsRemaining', null, field(meta.json, 'viewsRemaining') ?? null);
      await cleanup(app, plain.managePath);
    }

    for (const value of X.invalidViews) {
      const rejected = await upload(app, { c: content, views: value });
      rec.equal(`views=${JSON.stringify(value)} status`, statuses.badRequest, rejected.response.status);
      await cleanup(app, rejected.managePath);
    }
  });
};

/**
 * A limited paste must never be served without using a view: no public
 * caching, no ETag, and no 304, even for a matching If-None-Match.
 * views=2: a plain read, then a conditional read, then the paste is gone.
 */
export const viewsCacheSafety: CheckImpl = async ({ rec, pool }) => {
  await pool.withFresh(async (app) => {
    const content = X.contents.cacheSafety;
    const call = await upload(app, { c: content, views: String(X.cacheSafetyViews) });
    const path = uploaded(rec, 'limited', call);
    if (path === null) return;

    const meta = await readMeta(app, path);
    rec.check('metadata cache-control', 'no-store, not public', cacheControl(meta.response), noStore(meta.response));

    const first = await get(app, path);
    rec.equal('read 1 status', statuses.ok, first.status);
    rec.equal('read 1 body', content, first.bodyText);
    rec.check('read 1 cache-control', 'no-store, not public', cacheControl(first), noStore(first));
    const etag = header(first, 'etag');
    rec.equal('read 1 sends no ETag', '', etag);

    // Revalidate with the ETag the app sent, or with "*" (matches any version).
    const conditional = await get(app, path, { 'if-none-match': etag === '' ? '*' : etag });
    rec.check('conditional read 2 is not 304', `status ${statuses.ok}, never ${statuses.notModified}`, conditional.status, conditional.status !== statuses.notModified);
    rec.equal('conditional read 2 status', statuses.ok, conditional.status);
    rec.equal('conditional read 2 body', content, conditional.bodyText);
    rec.check('conditional read 2 cache-control', 'no-store, not public', cacheControl(conditional), noStore(conditional));

    const after = await get(app, path);
    rec.equal('read 3 status (two views used)', statuses.notFound, after.status);
    rec.check('read 3 does not return the content', 'no paste content', after.bodyText, !after.bodyText.includes(content));
    await cleanup(app, call.managePath);
  });
};

/**
 * Unlimited pastes: a strong ETag, 304 for a matching If-None-Match, 200 for
 * another ETag, a new ETag after an update, and public caching.
 */
export const deliveryConditional: CheckImpl = async ({ rec, pool }) => {
  await pool.withFresh(async (app) => {
    const content = X.contents.conditional;
    const call = await upload(app, { c: content });
    const path = uploaded(rec, 'unlimited', call);
    if (path === null) return;

    const first = await get(app, path);
    rec.equal('read 1 status', statuses.ok, first.status);
    const etag = header(first, 'etag');
    rec.check('read 1 strong ETag', 'quoted strong entity tag', etag, isStrongEtag(etag));
    const cache = cacheControl(first);
    const age = maxAge(cache);
    rec.check('read 1 cache-control is public', `public, max-age >= ${X.minPublicMaxAge}`, cache, /\bpublic\b/i.test(cache) && age !== null && age >= X.minPublicMaxAge);
    rec.equal('read 2 ETag is stable', etag, header(await get(app, path), 'etag'));
    rec.equal('HEAD ETag', etag, header(await head(app, path), 'etag'));
    if (!isStrongEtag(etag)) return;

    const notModified = await get(app, path, { 'if-none-match': etag });
    rec.equal('matching If-None-Match status', statuses.notModified, notModified.status);
    rec.equal('304 body', '', notModified.bodyText);
    rec.equal('304 ETag', etag, header(notModified, 'etag'));

    const other = await get(app, path, { 'if-none-match': '"converge-other-etag"' });
    rec.equal('other If-None-Match status', statuses.ok, other.status);
    rec.equal('other If-None-Match body', content, other.bodyText);

    if (call.managePath === null) return;
    const updatedContent = X.contents.conditionalUpdated;
    const update = await upload(app, { c: updatedContent }, { method: 'PUT', path: call.managePath });
    rec.equal('update status', statuses.ok, update.response.status);
    const afterUpdate = await get(app, path, { 'if-none-match': etag });
    rec.equal('old ETag after update status', statuses.ok, afterUpdate.status);
    rec.equal('old ETag after update body', updatedContent, afterUpdate.bodyText);
    rec.check('ETag changes after update', `not ${etag}`, header(afterUpdate, 'etag'), isStrongEtag(header(afterUpdate, 'etag')) && header(afterUpdate, 'etag') !== etag);
    await cleanup(app, call.managePath);
  });
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function showsRemaining(text: string, value: string): boolean {
  return new RegExp(X.displayPatterns.remaining.replaceAll('{v}', escapeRegExp(value)), 'i').test(text);
}

async function displayText(rec: Recorder, app: AppInstance, label: string, path: string): Promise<string> {
  const page = await get(app, rolePath('d', path));
  rec.equal(`${label} display status`, statuses.ok, page.status);
  rec.check(`${label} display content-type`, 'text/html', header(page, 'content-type'), header(page, 'content-type').startsWith('text/html'));
  const text = visibleText(page.bodyText);
  rec.check(`${label} display has no broken values`, 'no NaN, undefined, null, or [object Object]', text, !new RegExp(X.displayPatterns.brokenValue).test(text));
  return text;
}

/**
 * The display page shows the remaining views: "unlimited" for a paste without
 * a limit, and the count after this read for a limited paste (only when the
 * candidate also has view-limits). The API docs describe the fields.
 */
export const viewsDisplay: CheckImpl = async ({ rec, pool, capabilities }) => {
  await pool.withFresh(async (app) => {
    const docs = await get(app, X.docs.path);
    rec.equal('API docs status', statuses.ok, docs.status);
    for (const pattern of X.docs.fieldPatterns) {
      rec.check(`API docs describe ${pattern}`, pattern, docs.bodyText, docs.bodyText.includes(pattern));
    }

    const plain = await upload(app, { c: X.contents.display });
    const plainPath = uploaded(rec, 'unlimited', plain);
    if (plainPath !== null) {
      const text = await displayText(rec, app, 'unlimited', plainPath);
      rec.check('unlimited display shows remaining views: unlimited', 'Remaining views: unlimited', text, showsRemaining(text, 'unlimited'));
      await cleanup(app, plain.managePath);
    }

    if (!capabilities.has('view-limits')) return;
    const views = X.displayViews;
    const limited = await upload(app, { c: X.contents.display, views: String(views) });
    const path = uploaded(rec, 'limited', limited);
    if (path === null) return;
    rec.equal('metadata viewsRemaining before the display read', views, field((await readMeta(app, path)).json, 'viewsRemaining') ?? null);
    const text = await displayText(rec, app, 'limited', path);
    rec.check(`limited display shows remaining views: ${views - 1}`, `Remaining views: ${views - 1}`, text, showsRemaining(text, String(views - 1)));
    rec.equal('metadata viewsRemaining after the display read', views - 1, field((await readMeta(app, path)).json, 'viewsRemaining') ?? null);
    await cleanup(app, limited.managePath);
  });
};

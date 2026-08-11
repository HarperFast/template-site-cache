import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

/**
 * `resolveSourceRequest` recovers the originating HTTP request from inside a cache SOURCE's
 * instance `get()`. Harper v5 invokes the source with a dedicated source context that links
 * back to the originating request context via `requestContext`, so the request is found by
 * walking the context chain for the first object exposing a `url`.
 *
 * These cover each branch without booting Harper: the v4-style direct `request`, the
 * `getContext().request` shape, the nested `requestContext` shape that v5 actually produces,
 * the throw when nothing resolves, and cycle safety.
 *
 * `src/util/cache.ts` transitively imports a module that subclasses the Harper `Resource`
 * global at import time, so the globals are stubbed before a dynamic import — the same
 * pattern `tests/unit/ttlRules.test.ts` uses.
 */
let resolveSourceRequest: (resource: any) => any;

const asResource = (shape: Record<string, unknown>) => shape as any;

before(async () => {
	(globalThis as any).Resource = class {};
	(globalThis as any).logger = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
	(globalThis as any).databases = {
		CacheManagement: {
			TTLRules: {
				create: async () => {},
				put: async () => {},
				search: async function* () {},
				subscribe: async () => ({ on: () => {} }),
			},
		},
	};

	const cacheModule = await import(`../../src/util/cache.ts?test=${Date.now()}`);
	resolveSourceRequest = cacheModule.resolveSourceRequest;
});

describe('resolveSourceRequest', () => {
	test('returns the direct request when the resource exposes one (v4 compatibility)', () => {
		const request = { url: 'https://example.com/a', headers: {} };
		assert.equal(resolveSourceRequest(asResource({ request })), request);
	});

	test('returns getContext().request when the direct request is absent', () => {
		const request = { url: 'https://example.com/b', headers: {} };
		assert.equal(resolveSourceRequest(asResource({ getContext: () => ({ request }) })), request);
	});

	test('walks requestContext to the object carrying a url (the v5 source-context shape)', () => {
		const originating = { url: 'https://example.com/c', headers: {} };
		const resource = asResource({ getContext: () => ({ requestContext: originating }) });
		assert.equal(resolveSourceRequest(resource), originating);
	});

	test('walks a multi-hop context chain', () => {
		const originating = { url: 'https://example.com/d', headers: {} };
		const resource = asResource({ getContext: () => ({ requestContext: { requestContext: originating } }) });
		assert.equal(resolveSourceRequest(resource), originating);
	});

	test('prefers a direct request that carries a url over the context chain', () => {
		const direct = { url: 'https://example.com/direct', headers: {} };
		const resource = asResource({
			request: direct,
			getContext: () => ({ requestContext: { url: 'https://example.com/ctx' } }),
		});
		assert.equal(resolveSourceRequest(resource), direct);
	});

	test('returns a urlless direct request rather than throwing', () => {
		// `direct` is truthy but has no `.url`; the chain yields nothing. The function keeps the
		// object so the caller sees the shape it was given instead of a resolution error.
		const direct = { headers: {} };
		assert.equal(resolveSourceRequest(asResource({ request: direct })), direct);
	});

	test('throws a descriptive error when no request can be resolved', () => {
		const resource = asResource({ getId: () => 'cache-key-1', getContext: () => ({}) });
		assert.throws(() => resolveSourceRequest(resource), /could not resolve originating request/);
		assert.throws(() => resolveSourceRequest(resource), /cache-key-1/);
	});

	test('throws rather than looping forever on a cyclic context chain', () => {
		const ctx: Record<string, unknown> = {};
		ctx.requestContext = ctx;
		assert.throws(
			() => resolveSourceRequest(asResource({ getContext: () => ctx })),
			/could not resolve originating request/
		);
	});

	test('throws when the resource has neither a request nor a context', () => {
		assert.throws(() => resolveSourceRequest(asResource({})), /could not resolve originating request/);
	});
});

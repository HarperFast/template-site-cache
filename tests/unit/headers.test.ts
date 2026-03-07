import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	buildDownstreamHeaders,
	buildUpstreamHeaders,
	cacheGetObservabilityHeaders,
	cachePutObservabilityHeaders,
	headerGet,
	normalizeHeaders,
} from '../../src/util/headers.ts';

describe('normalizeHeaders', () => {
	it('normalizes plain objects and strips cache-unsafe encodings', () => {
		const input = {
			'accept-encoding': 'gzip',
			'content-encoding': 'br',
			'transfer-encoding': 'chunked',
			'cache-control': 'max-age=120',
		};

		const out = normalizeHeaders(input);

		assert.deepEqual(out, {
			'cache-control': 'max-age=120',
			'x-hdb': 'true',
		});
		assert.equal(input['accept-encoding'], 'gzip');
	});

	it('normalizes Fetch Headers and strips removed keys case-insensitively', () => {
		const out = normalizeHeaders(
			new Headers({
				'Accept-Encoding': 'gzip',
				'Content-Encoding': 'br',
				'Transfer-Encoding': 'chunked',
				'ETag': 'abc123',
			})
		);

		assert.deepEqual(out, {
			'etag': 'abc123',
			'x-hdb': 'true',
		});
	});
});

describe('buildUpstreamHeaders', () => {
	it('removes hop-by-hop and pseudo headers', () => {
		const headers: Record<string, string> = {
			'Connection': 'keep-alive',
			'keep-alive': 'timeout=5',
			':authority': 'example.com',
			'x-request-id': 'abc',
		};

		Object.defineProperty(headers, 'delete', {
			value(key: string) {
				delete headers[key];
			},
			enumerable: false,
		});

		const out = buildUpstreamHeaders(headers as any);

		assert.equal(out, headers);
		assert.equal('Connection' in headers, false);
		assert.equal('keep-alive' in headers, false);
		assert.equal(':authority' in headers, false);
		assert.equal(headers['x-request-id'], 'abc');
	});
});

describe('buildDownstreamHeaders', () => {
	it('drops hop-by-hop and misleading body headers and sets x-hdb', () => {
		const out = buildDownstreamHeaders({
			'Connection': 'keep-alive',
			'TE': 'trailers',
			'content-encoding': 'br',
			'Content-Length': '123',
			'x-custom': 'ok',
		});

		assert.equal(out.get('connection'), null);
		assert.equal(out.get('te'), null);
		assert.equal(out.get('content-encoding'), null);
		assert.equal(out.get('content-length'), null);
		assert.equal(out.get('x-custom'), 'ok');
		assert.equal(out.get('x-hdb'), 'true');
	});
});

describe('headerGet', () => {
	it('reads values from Fetch Headers and plain objects', () => {
		const fetchHeaders = new Headers({ 'X-Request-Id': 'req-1' });
		assert.equal(headerGet(fetchHeaders, 'x-request-id'), 'req-1');

		const objHeaders = { 'x-trace-id': 'trace-1' };
		assert.equal(headerGet(objHeaders, 'X-TRACE-ID'), 'trace-1');
		assert.equal(headerGet(objHeaders, 'missing'), '');
		assert.equal(headerGet(undefined, 'missing'), '');
	});
});

describe('cache observability headers', () => {
	it('builds cache put observability headers from request and rule metadata', () => {
		const req = { url: '/products?page=2' } as any;

		const out = cachePutObservabilityHeaders(
			req,
			{
				ruleName: 'Product listing',
				ruleId: 42,
				policy: 'ttl',
				ttlSeconds: 300,
				bucketPrefix: '/products',
				matchedPattern: '^/products$',
			},
			'cache-key-1'
		);

		assert.deepEqual(out, {
			'x-hdb-cache-path': '/products?page=2',
			'x-hdb-cache-rule': 'Product listing',
			'x-hdb-cache-rule-id': '42',
			'x-hdb-cache-policy': 'ttl',
			'x-hdb-cache-ttl': '300',
			'x-hdb-cache-bucket': '/products',
			'x-hdb-cache-pattern': '^/products$',
			'x-hdb-cache-key': 'cache-key-1',
		});
	});

	it('builds cache get observability headers and computes ttl remaining', () => {
		const now = 1_700_000_000_000;
		const originalNow = Date.now;
		Date.now = () => now;

		try {
			const req = { url: '/fresh' } as any;
			const cacheRecord = {
				debugHeaders: JSON.stringify({
					'x-debug': 'true',
					'x-hdb-cache-path': '/stale',
				}),
				getMetadata: () => ({ expiresAt: now + 4_500 }),
			};

			const out = cacheGetObservabilityHeaders(req, 'cache-key-2', cacheRecord);

			assert.equal(out['x-debug'], 'true');
			assert.equal(out['x-hdb-cache-path'], '/fresh');
			assert.equal(out['x-hdb-cache-key'], 'cache-key-2');
			assert.equal(out['x-hdb-cache-ttl-remaining-sec'], 4.5);
		} finally {
			Date.now = originalNow;
		}
	});
});

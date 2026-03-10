import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createServer } from 'node:http';
import { Agent, fetch } from 'undici';

const TEST_DOMAIN = process.env.TEST_DOMAIN || 'https://localhost:9926';
const OPERATIONS_URL = process.env.HDB_OPERATIONS_URL || 'http://localhost:9925';
const REQUEST_TIMEOUT_MS = Number(process.env.INTEGRATION_TIMEOUT_MS || '90000');

const MOCK_BIND_HOST = process.env.MOCK_ORIGIN_BIND_HOST || '0.0.0.0';
const MOCK_ORIGIN_HOST = process.env.MOCK_ORIGIN_HOST || '172.17.0.1';
const MOCK_DEFAULT_ORIGIN_PORT = Number(process.env.MOCK_DEFAULT_ORIGIN_PORT || '4101');
const MOCK_API_ORIGIN_PORT = Number(process.env.MOCK_API_ORIGIN_PORT || '4102');

const EXPECTED_DEFAULT_ORIGIN_URL =
	process.env.MOCK_DEFAULT_ORIGIN_URL || `http://${MOCK_ORIGIN_HOST}:${MOCK_DEFAULT_ORIGIN_PORT}`;
const EXPECTED_API_ORIGIN_URL = process.env.MOCK_API_ORIGIN_URL || `http://${MOCK_ORIGIN_HOST}:${MOCK_API_ORIGIN_PORT}`;

const adminUsername = process.env.HDB_ADMIN_USERNAME || 'HDB_ADMIN';
const adminPassword = process.env.HDB_ADMIN_PASSWORD || 'password';
const authHeader = `Basic ${Buffer.from(`${adminUsername}:${adminPassword}`).toString('base64')}`;

const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

const PAGE_HEADERS = {
	'device-type': 'desktop',
	'accept-language': 'en-US',
	'cookie': 'brand=ae',
};

let defaultOrigin = null;
let apiOrigin = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const harperOpsRequest = (body) =>
	fetch(`${OPERATIONS_URL}/`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'Authorization': authHeader,
		},
		body: JSON.stringify(body),
		dispatcher: insecureAgent,
	});

const dropDatabase = async (database) => {
	const response = await harperOpsRequest({ operation: 'drop_database', database });
	if (!response.ok) {
		const text = await response.text();
		// "does not exist" is fine — nothing to drop
		if (!/does not exist|unknown database/i.test(text)) {
			console.warn(`Warning: drop_database(${database}) returned ${response.status}: ${text}`);
		}
	}
};

const resetHarperState = async () => {
	await Promise.all([dropDatabase('DefaultCache'), dropDatabase('APICache'), dropDatabase('CacheManagement')]);

	// Restart may close the connection before a response arrives — that's expected
	await harperOpsRequest({ operation: 'restart_service', service: 'http_workers' }).catch(() => {});

	// Give the process a moment to begin shutting down before we start polling
	await delay(2000);
};

const closeServer = async (server) => {
	await new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
};

const readRequestBody = async (request) =>
	await new Promise((resolve, reject) => {
		const chunks = [];
		request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		request.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)));
		request.on('error', reject);
	});

const startDefaultOrigin = async () => {
	const hitCounts = new Map();
	const key = (method, pathname) => `${method.toUpperCase()} ${pathname}`;
	const routePrefix = `/it/${runId}/page/`;

	const server = createServer((request, response) => {
		const url = new URL(request.url || '/', 'http://localhost');
		const method = (request.method || 'GET').toUpperCase();
		const hitKey = key(method, url.pathname);
		hitCounts.set(hitKey, (hitCounts.get(hitKey) || 0) + 1);
		const hit = hitCounts.get(hitKey) || 0;

		if (method === 'GET' && url.pathname.startsWith(routePrefix)) {
			response.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'x-origin-cache-tags': `tag:${url.pathname.replace(/\//g, '_')}`,
			});
			response.end(`<html><body>${url.pathname}|hit=${hit}</body></html>`);
			return;
		}

		response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		response.end('default origin route not found');
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(MOCK_DEFAULT_ORIGIN_PORT, MOCK_BIND_HOST, () => resolve());
	});

	return {
		origin: `http://${MOCK_BIND_HOST}:${MOCK_DEFAULT_ORIGIN_PORT}`,
		hitsFor(method, pathname) {
			return hitCounts.get(key(method, pathname)) || 0;
		},
		close: async () => {
			await closeServer(server);
		},
	};
};

const startAPIOrigin = async () => {
	const hitCounts = new Map();
	const key = (method, pathname) => `${method.toUpperCase()} ${pathname}`;
	const productsPath = `/it/${runId}/products`;
	const echoPath = `/it/${runId}/echo`;
	const headerRoutePath = `/it/${runId}/header-route`;

	const server = createServer(async (request, response) => {
		const url = new URL(request.url || '/', 'http://localhost');
		const method = (request.method || 'GET').toUpperCase();
		const hitKey = key(method, url.pathname);
		hitCounts.set(hitKey, (hitCounts.get(hitKey) || 0) + 1);
		const hit = hitCounts.get(hitKey) || 0;

		if (method === 'GET' && url.pathname === productsPath) {
			response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			response.end(
				JSON.stringify({
					hit,
					path: url.pathname,
					query: Object.fromEntries(url.searchParams.entries()),
				})
			);
			return;
		}

		if (method === 'GET' && url.pathname === headerRoutePath) {
			response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			response.end(
				JSON.stringify({
					hit,
					path: url.pathname,
					query: Object.fromEntries(url.searchParams.entries()),
					route: 'header',
				})
			);
			return;
		}

		if (method === 'POST' && url.pathname === echoPath) {
			const body = await readRequestBody(request);
			response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			response.end(
				JSON.stringify({
					hit,
					path: url.pathname,
					body: body.toString('utf8'),
				})
			);
			return;
		}

		response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
		response.end(JSON.stringify({ error: 'api origin route not found' }));
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(MOCK_API_ORIGIN_PORT, MOCK_BIND_HOST, () => resolve());
	});

	return {
		origin: `http://${MOCK_BIND_HOST}:${MOCK_API_ORIGIN_PORT}`,
		hitsFor(method, pathname) {
			return hitCounts.get(key(method, pathname)) || 0;
		},
		close: async () => {
			await closeServer(server);
		},
	};
};

const harperRequest = async (pathname, init = {}) => {
	const headers = new Headers(init.headers || {});
	if (!headers.has('authorization')) {
		headers.set('authorization', authHeader);
	}

	return fetch(`${TEST_DOMAIN}${pathname}`, {
		...init,
		headers,
		dispatcher: insecureAgent,
	});
};

const callJSONResource = async (resourcePath, body, expectedStatuses) => {
	try {
		const response = await harperRequest(resourcePath, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		});
	
		const responseText = await response.text();
	
		assert.ok(
			expectedStatuses.includes(response.status),
			`${resourcePath} returned ${response.status}. Body: ${responseText}`
		);
	} catch (e) {
		console.log(e);
		throw new Error(`Error calling ${resourcePath}: ${e.message}`);
	}
};

const createTTLRule = async (rule) => {
	await callJSONResource('/cache/ttlConfig', rule, [200, 201, 204]);
};

const invalidateByType = async (type) => {
	await callJSONResource('/cache/invalidate', { type }, [200]);
};

const invalidateByCacheTag = async (cacheTag) => {
	await callJSONResource('/cache/invalidate', { type: 'cacheTag', cacheTag }, [200]);
};

const waitForCacheState = async (requestPath, headers, expectedState, failureHint) => {
	const deadline = Date.now() + REQUEST_TIMEOUT_MS;
	let lastObservation = 'no observation yet';

	while (Date.now() < deadline) {
		const response = await harperRequest(requestPath, { headers });
		const cacheState = response.headers.get('x-hdb-cache');
		if (cacheState === expectedState) return response;

		const body = await response.text();
		lastObservation = `status=${response.status}, x-hdb-cache=${cacheState}, body=${body.slice(0, 240)}`;

		// Surface server-side configuration issues immediately instead of waiting for full timeout.
		if (response.status >= 500 && /Invalid URL/i.test(body)) {
			throw new Error(
				`Received server error while waiting for x-hdb-cache=${expectedState} on ${requestPath}. ${lastObservation}. ${failureHint}`
			);
		}

		await delay(250);
	}

	throw new Error(
		`Timed out waiting for x-hdb-cache=${expectedState} on ${requestPath}. Last observation: ${lastObservation}. ${failureHint}`
	);
};

const validateMockOriginRouting = async () => {
	const pagePath = `/it/${runId}/page/preflight?sort=probe&page=1&filter=probe`;
	const apiPath = `/api/it/${runId}/products?probe=true`;

	await waitForCacheState(
		pagePath,
		PAGE_HEADERS,
		'miss',
		`Ensure deployed cache configuration default origin points to ${EXPECTED_DEFAULT_ORIGIN_URL}`
	);

	await waitForCacheState(
		apiPath,
		{},
		'miss',
		`Ensure deployed cache configuration api origin points to ${EXPECTED_API_ORIGIN_URL}`
	);

	const defaultPreflightHits = defaultOrigin.hitsFor('GET', `/it/${runId}/page/preflight`);
	const apiPreflightHits = apiOrigin.hitsFor('GET', `/it/${runId}/products`);

	assert.ok(
		defaultPreflightHits > 0,
		`Mock default origin did not receive traffic. Expected Harper default origin URL ${EXPECTED_DEFAULT_ORIGIN_URL}`
	);
	assert.ok(
		apiPreflightHits > 0,
		`Mock API origin did not receive traffic. Expected Harper API origin URL ${EXPECTED_API_ORIGIN_URL}`
	);
};

describe('cache integration against deployed Harper (mocked origins)', { concurrency: 1 }, () => {
	before(async () => {
		if (!TEST_DOMAIN) {
			throw new Error('TEST_DOMAIN is required for integration tests. Example: TEST_DOMAIN=http://localhost:9926');
		}

		await resetHarperState();

		defaultOrigin = await startDefaultOrigin();
		apiOrigin = await startAPIOrigin();

		await createTTLRule({
			id: `page-rule-${runId}`,
			description: 'integration page rule',
			pathPatterns: [`^/[iI][tT]/${runId}/[pP][aA][gG][eE]/.*$`],
			ttl: '10m',
		});

		await createTTLRule({
			id: `api-rule-${runId}`,
			description: 'integration api rule',
			pathPatterns: [`^/api/it/${runId}/products$`],
			ttl: '10m',
		});

		await createTTLRule({
			id: `api-header-rule-${runId}`,
			description: 'integration api header-routed rule',
			pathPatterns: [`^/it/${runId}/header-route$`],
			ttl: '10m',
		});

		await createTTLRule({
			id: `api-404-rule-${runId}`,
			description: 'integration api non-200 rule',
			pathPatterns: [`^/api/it/${runId}/missing$`],
			ttl: '10m',
		});

		await validateMockOriginRouting();
	});

	after(async () => {
		await Promise.allSettled([defaultOrigin?.close?.(), apiOrigin?.close?.(), insecureAgent.close()]);
	});

	test('page requests miss first then hit cache', async () => {
		const requestPath = `/it/${runId}/page/home?sort=popular&page=1&filter=shirts`;
		const originPath = `/it/${runId}/page/home`;
		const beforeHits = defaultOrigin.hitsFor('GET', originPath);

		const first = await harperRequest(requestPath, { headers: PAGE_HEADERS });
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestPath, { headers: PAGE_HEADERS });
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		assert.equal(defaultOrigin.hitsFor('GET', originPath) - beforeHits, 1);
	});

	test('page cache key treats path casing as equivalent', async () => {
		const requestA = `/it/${runId}/page/case-check?sort=alpha&page=1&filter=shirts`;
		const requestB = `/IT/${runId}/PAGE/case-check?sort=alpha&page=1&filter=shirts`;
		const lowerOriginPath = `/it/${runId}/page/case-check`;
		const upperOriginPath = `/IT/${runId}/PAGE/case-check`;

		const lowerBefore = defaultOrigin.hitsFor('GET', lowerOriginPath);
		const upperBefore = defaultOrigin.hitsFor('GET', upperOriginPath);

		const first = await harperRequest(requestA, { headers: PAGE_HEADERS });
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestB, { headers: PAGE_HEADERS });
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		assert.equal(defaultOrigin.hitsFor('GET', lowerOriginPath) - lowerBefore, 1);
		assert.equal(defaultOrigin.hitsFor('GET', upperOriginPath) - upperBefore, 0);
	});

	test('page cache key treats paths with and without trailing slash as equivalent', async () => {
		const requestA = `/it/${runId}/page/trailing/?sort=alpha&page=1&filter=shirts`;
		const requestB = `/it/${runId}/page/trailing?sort=alpha&page=1&filter=shirts`;
		const withSlashOriginPath = `/it/${runId}/page/trailing/`;
		const withoutSlashOriginPath = `/it/${runId}/page/trailing`;

		const withSlashBefore = defaultOrigin.hitsFor('GET', withSlashOriginPath);
		const withoutSlashBefore = defaultOrigin.hitsFor('GET', withoutSlashOriginPath);

		const first = await harperRequest(requestA, { headers: PAGE_HEADERS });
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestB, { headers: PAGE_HEADERS });
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		assert.equal(defaultOrigin.hitsFor('GET', withSlashOriginPath) - withSlashBefore, 1);
		assert.equal(defaultOrigin.hitsFor('GET', withoutSlashOriginPath) - withoutSlashBefore, 0);
	});

	test('page cache key ignores query params outside include list', async () => {
		const requestA = `/it/${runId}/page/query-include?sort=popular&page=1&filter=shirts&utm_source=google`;
		const requestB = `/it/${runId}/page/query-include?sort=popular&page=1&filter=shirts&utm_source=bing&foo=bar`;
		const originPath = `/it/${runId}/page/query-include`;
		const beforeHits = defaultOrigin.hitsFor('GET', originPath);

		const first = await harperRequest(requestA, { headers: PAGE_HEADERS });
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestB, { headers: PAGE_HEADERS });
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		assert.equal(defaultOrigin.hitsFor('GET', originPath) - beforeHits, 1);
	});

	test('api requests are cached and query order is canonicalized', async () => {
		const requestA = `/api/it/${runId}/products?zotherParam=2&foo=bar&test=1`;
		const requestB = `/api/it/${runId}/products?test=1&foo=bar&zotherParam=2`;
		const originPath = `/it/${runId}/products`;
		const beforeHits = apiOrigin.hitsFor('GET', originPath);

		const first = await harperRequest(requestA);
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestB);
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		assert.equal(apiOrigin.hitsFor('GET', originPath) - beforeHits, 1);
	});

	test('api cache key honors configured includeHeaders values', async () => {
		const requestPath = `/api/it/${runId}/products?foo=bar`;
		const originPath = `/it/${runId}/products`;
		const beforeHits = apiOrigin.hitsFor('GET', originPath);

		const first = await harperRequest(requestPath, {
			headers: {
				version: 'v1',
			},
		});
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestPath, {
			headers: {
				version: 'v2',
			},
		});
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'miss');

		const third = await harperRequest(requestPath, {
			headers: {
				version: 'v1',
			},
		});
		assert.equal(third.status, 200);
		assert.equal(third.headers.get('x-hdb-cache'), 'hit');

		assert.equal(apiOrigin.hitsFor('GET', originPath) - beforeHits, 2);
	});

	test('non-GET API requests are proxied without cache hits', async () => {
		const requestPath = `/api/it/${runId}/echo`;
		const originPath = `/it/${runId}/echo`;
		const beforeHits = apiOrigin.hitsFor('POST', originPath);

		const first = await harperRequest(requestPath, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({ message: 'hello' }),
		});
		assert.equal(first.status, 200);
		assert.notEqual(first.headers.get('x-hdb-cache'), 'hit');

		const second = await harperRequest(requestPath, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({ message: 'hello' }),
		});
		assert.equal(second.status, 200);
		assert.notEqual(second.headers.get('x-hdb-cache'), 'hit');

		assert.equal(apiOrigin.hitsFor('POST', originPath) - beforeHits, 2);
	});

	test('api requests route to API origin when X-Fwd-Origin header is set, even without /api path', async () => {
		const requestPath = `/it/${runId}/header-route?foo=bar`;
		const originPath = `/it/${runId}/header-route`;
		const apiBeforeHits = apiOrigin.hitsFor('GET', originPath);
		const defaultBeforeHits = defaultOrigin.hitsFor('GET', originPath);

		const first = await harperRequest(requestPath, {
			headers: {
				'x-fwd-origin': 'API',
			},
		});
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestPath, {
			headers: {
				'x-fwd-origin': 'API',
			},
		});
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		assert.equal(apiOrigin.hitsFor('GET', originPath) - apiBeforeHits, 1);
		assert.equal(defaultOrigin.hitsFor('GET', originPath) - defaultBeforeHits, 0);
	});

	test('non-200 API responses are not cached', async () => {
		const requestPath = `/api/it/${runId}/missing?code=404`;
		const originPath = `/it/${runId}/missing`;
		const beforeHits = apiOrigin.hitsFor('GET', originPath);

		const first = await harperRequest(requestPath);
		assert.equal(first.status, 404);
		assert.equal(first.headers.get('x-hdb-cache'), 'no-cache');

		const second = await harperRequest(requestPath);
		assert.equal(second.status, 404);
		assert.equal(second.headers.get('x-hdb-cache'), 'no-cache');

		assert.equal(apiOrigin.hitsFor('GET', originPath) - beforeHits, 2);
	});

	test('cacheTag invalidation removes matching page cache entries', async () => {
		const requestPath = `/it/${runId}/page/tag-invalidation?sort=popular&page=1&filter=tees`;
		const originPath = `/it/${runId}/page/tag-invalidation`;
		const beforeHits = defaultOrigin.hitsFor('GET', originPath);
		const cacheTag = `tag:${originPath.replace(/\//g, '_')}`;

		const first = await harperRequest(requestPath, { headers: PAGE_HEADERS });
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestPath, { headers: PAGE_HEADERS });
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		await invalidateByCacheTag(cacheTag);

		await waitForCacheState(
			requestPath,
			PAGE_HEADERS,
			'miss',
			`cacheTag invalidation did not evict entries for ${cacheTag}`
		);

		const final = await waitForCacheState(
			requestPath,
			PAGE_HEADERS,
			'hit',
			'Cache was not re-populated after cacheTag invalidation miss'
		);
		assert.equal(final.status, 200);

		assert.ok(defaultOrigin.hitsFor('GET', originPath) - beforeHits >= 2);
	});

	test('page invalidation forces cache refresh', async () => {
		const requestPath = `/it/${runId}/page/invalidation?sort=popular&page=1&filter=tees`;
		const originPath = `/it/${runId}/page/invalidation`;
		const beforeHits = defaultOrigin.hitsFor('GET', originPath);

		const first = await harperRequest(requestPath, { headers: PAGE_HEADERS });
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestPath, { headers: PAGE_HEADERS });
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		await invalidateByType('page');

		await waitForCacheState(
			requestPath,
			PAGE_HEADERS,
			'miss',
			'Page invalidation did not become visible to cache handlers within timeout.'
		);

		const final = await waitForCacheState(
			requestPath,
			PAGE_HEADERS,
			'hit',
			'Cache was not re-populated after page invalidation miss'
		);
		assert.equal(final.status, 200);

		assert.ok(defaultOrigin.hitsFor('GET', originPath) - beforeHits >= 2);
	});

	test('api invalidation forces cache refresh', async () => {
		const requestPath = `/api/it/${runId}/products`;
		const originPath = `/it/${runId}/products`;
		const beforeHits = apiOrigin.hitsFor('GET', originPath);

		const first = await harperRequest(requestPath);
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('x-hdb-cache'), 'miss');

		const second = await harperRequest(requestPath);
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('x-hdb-cache'), 'hit');

		await invalidateByType('api');

		await waitForCacheState(
			requestPath,
			{},
			'miss',
			'API invalidation did not become visible to cache handlers within timeout.'
		);

		const final = await waitForCacheState(
			requestPath,
			{},
			'hit',
			'Cache was not re-populated after API invalidation miss'
		);
		assert.equal(final.status, 200);

		assert.ok(apiOrigin.hitsFor('GET', originPath) - beforeHits >= 2);
	});
});

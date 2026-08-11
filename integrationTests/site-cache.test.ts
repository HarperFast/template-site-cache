/**
 * Integration tests for the Harper v5 site-cache component, run against a real Harper
 * instance started by @harperfast/integration-testing (no Docker image required).
 *
 * These tests specifically guard the v5 caching-source contract: a cache table that is
 * `sourcedFrom` a Resource invokes the source's `get()` on a miss (this component uses the
 * standard instance `get()` pattern, matching Harper's reference cache source), stores the
 * returned record, and serves subsequent requests from the store.
 *
 * Coverage:
 *  - cache MISS invokes the source exactly once (origin is hit), response served.
 *  - subsequent request is a cache HIT served from the store WITHOUT re-invoking the source
 *    (origin hit count unchanged) — the cached-hit / "served-without-revalidation" path.
 *  - a cache HIT preserves the origin ETag on the response (the conditional-revalidation
 *    primitive a downstream client/CDN uses), served without re-invoking the source.
 *  - explicit invalidation evicts the entry; the next request re-invokes the source and
 *    re-caches (origin hit count increments, then a fresh hit is served).
 *
 * NOTE: server-side If-None-Match / 304 conditional handling is NOT implemented at the
 * component layer, so that path is covered by a skipped test (see below) rather than an
 * assertion; the component only proxies the origin's ETag into the cached response.
 *
 * The component fixture is assembled from the freshly built `dist/` so the test always runs
 * the current source. A local mock origin (started in-process) stands in for the upstream.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// harper's `exports` map only exposes ".", so 'harper/dist/bin/harper.js' is not resolvable
// via require.resolve directly. Resolve the bin from the package main entry and pass it
// explicitly as harperBinPath. (Documented harness escape hatch.)
const harperBinPath = resolve(dirname(require.resolve('harper')), 'bin/harper.js');

// A fixed origin port the in-test mock origin listens on. The mock binds 0.0.0.0 so the
// Harper child process (bound to a 127.0.0.x loopback) can reach it at 127.0.0.1.
const ORIGIN_PORT = Number(process.env.MOCK_ORIGIN_PORT || 47185);
const ORIGIN_URL = `http://127.0.0.1:${ORIGIN_PORT}`;
const ENV_NAME = 'harnesstest';

let originServer: Server;
let originHits = new Map<string, number>();
let fixtureDir: string;
let configPath: string;

const PAGE_HEADERS = { 'device-type': 'desktop', 'accept-language': 'en-US', 'cookie': 'brand=ae' };

const hitKey = (method: string, pathname: string) => `${method.toUpperCase()} ${pathname}`;
const hitsFor = (method: string, pathname: string) => originHits.get(hitKey(method, pathname)) || 0;

/** Start an in-process mock origin that serves cacheable HTML with a stable ETag. */
const startMockOrigin = () =>
	new Promise<void>((resolveListen, reject) => {
		originServer = createServer((req, res) => {
			const url = new URL(req.url || '/', 'http://localhost');
			const method = (req.method || 'GET').toUpperCase();
			const k = hitKey(method, url.pathname);
			originHits.set(k, (originHits.get(k) || 0) + 1);
			const hit = originHits.get(k) || 0;

			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'x-origin-cache-tags': `tag:${url.pathname.replace(/\//g, '_')}`,
				'etag': `"page-${url.pathname}"`,
				'cache-control': 'public, max-age=600',
			});
			res.end(`<html><body>${url.pathname}|hit=${hit}</body></html>`);
		});
		originServer.once('error', reject);
		originServer.listen(ORIGIN_PORT, '0.0.0.0', () => resolveListen());
	});

/** Assemble a self-contained component fixture from the freshly built dist/. */
const buildFixture = () => {
	// Build the TypeScript component into dist/.
	execFileSync('npx', ['tsc'], { cwd: REPO_ROOT, stdio: 'inherit' });
	assert.ok(existsSync(join(REPO_ROOT, 'dist', 'index.js')), 'dist/index.js must exist after build');

	fixtureDir = mkdtempSync(join(tmpdir(), 'site-cache-fixture-'));
	const appDir = join(fixtureDir, 'site-cache');
	mkdirSync(appDir, { recursive: true });

	cpSync(join(REPO_ROOT, 'dist'), join(appDir, 'dist'), { recursive: true });
	cpSync(join(REPO_ROOT, 'src', 'db'), join(appDir, 'src', 'db'), { recursive: true });
	cpSync(join(REPO_ROOT, 'config.yaml'), join(appDir, 'config.yaml'));

	// The built component imports `undici` at runtime. Harper's v5 module loader resolves
	// dependencies relative to the component directory, so vendor the (dependency-free) undici
	// package into the fixture's node_modules and declare it in a package.json.
	cpSync(join(REPO_ROOT, 'node_modules', 'undici'), join(appDir, 'node_modules', 'undici'), { recursive: true });
	writeFileSync(
		join(appDir, 'package.json'),
		JSON.stringify({ name: 'site-cache', version: '1.0.0', type: 'module', dependencies: { undici: '*' } }, null, 2)
	);

	// Origin configuration consumed by the component (selected via ENVIRONMENT).
	const cacheConfig = {
		cacheTagsHeader: 'X-Origin-Cache-Tags',
		apiPathPrefix: '/api/',
		apiHeader: { key: 'X-Fwd-Origin', value: 'API' },
		apiPathReplacement: { search: '/api/', replace: '' },
		apiOrigin: ORIGIN_URL,
		apiOriginAuthHeader: '',
		apiCacheKey: { includeHeaders: ['accept', 'version'], includeQueryParams: 'ALL', includeCookies: [] },
		defaultOrigin: ORIGIN_URL,
		defaultOriginAuthHeader: '',
		defaultPathReplacement: false,
		defaultCacheKey: {
			includeHeaders: ['device-type', 'accept-language'],
			includeQueryParams: ['sort', 'page', 'filter'],
			includeCookies: ['brand'],
		},
	};
	// constants/index.ts resolves cacheConfiguration.<env>.json from process.cwd(), which for the
	// Harper process is the repo root (where the test runner is invoked) — not the component dir.
	// Write the config there; ENVIRONMENT is provided to the Harper process via the harness `env`
	// option so the selector is set before the component's top-level code runs.
	configPath = join(REPO_ROOT, `cacheConfiguration.${ENV_NAME}.json`);
	writeFileSync(configPath, JSON.stringify(cacheConfig, null, 2));

	return appDir;
};

suite('site-cache component (Harper v5)', (ctx: ContextWithHarper) => {
	let httpURL: string;
	let authHeader: string;

	before(async () => {
		await startMockOrigin();
		const appDir = buildFixture();
		await setupHarperWithFixture(ctx, appDir, { harperBinPath, env: { ENVIRONMENT: ENV_NAME } });
		httpURL = ctx.harper.httpURL.replace(/\/$/, '');
		// The component authenticates via server.authenticateUser; use the instance's admin
		// (a super_user, which satisfies both ALLOWED_ROLES_CACHE and ALLOWED_ROLES_ADMIN).
		const { username, password } = ctx.harper.admin;
		authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
		// Configure a TTL rule so page requests under /page/ are cacheable.
		const ttlRes = await fetch(`${httpURL}/cache/ttlConfig`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'authorization': authHeader },
			body: JSON.stringify({
				id: 'page-rule',
				description: 'harness page rule',
				pathPatterns: ['^/page/.*$'],
				ttl: '10m',
			}),
		});
		assert.ok([200, 201, 204].includes(ttlRes.status), `ttlConfig create failed: ${ttlRes.status}`);
		// Allow the in-memory TTL rule subscription to pick up the new rule.
		await new Promise((r) => setTimeout(r, 1500));
	});

	after(async () => {
		await teardownHarper(ctx);
		await new Promise<void>((r) => originServer?.close(() => r()));
		if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
		if (configPath) rmSync(configPath, { force: true });
	});

	const harperGet = (path: string, headers: Record<string, string> = {}) =>
		fetch(`${httpURL}${path}`, { headers: { authorization: authHeader, ...headers } });

	test('cache miss invokes the source once, then serves a hit without re-invoking it', async () => {
		const reqPath = '/page/home?sort=popular&page=1&filter=shirts';
		const originPath = '/page/home';
		const before = hitsFor('GET', originPath);

		const miss = await harperGet(reqPath, PAGE_HEADERS);
		assert.equal(miss.status, 200);
		assert.equal(miss.headers.get('x-harper-cache'), 'miss');
		await miss.text();
		assert.equal(hitsFor('GET', originPath) - before, 1, 'source/origin should be invoked exactly once on miss');

		const hit = await harperGet(reqPath, PAGE_HEADERS);
		assert.equal(hit.status, 200);
		assert.equal(hit.headers.get('x-harper-cache'), 'hit');
		await hit.text();
		// A broken static source would re-fetch (or store empty) here; a correct instance source
		// serves from cache without touching the origin again.
		assert.equal(hitsFor('GET', originPath) - before, 1, 'cache hit must not re-invoke the source');
	});

	test('cached hit preserves the origin ETag and is served without revalidating the source', async () => {
		// The component proxies the origin's validators (ETag) into the cached response, which is
		// the conditional-revalidation primitive a downstream client/CDN uses to obtain a 304.
		// A broken static source would store a bodyless record with no preserved ETag.
		const reqPath = '/page/conditional?sort=popular&page=1&filter=shirts';
		const originPath = '/page/conditional';
		const before = hitsFor('GET', originPath);

		const miss = await harperGet(reqPath, PAGE_HEADERS);
		assert.equal(miss.status, 200);
		assert.equal(miss.headers.get('x-harper-cache'), 'miss');
		const missEtag = miss.headers.get('etag');
		await miss.text();
		assert.ok(missEtag, 'origin ETag must be present on the miss response');

		const hit = await harperGet(reqPath, PAGE_HEADERS);
		assert.equal(hit.status, 200);
		assert.equal(hit.headers.get('x-harper-cache'), 'hit');
		assert.equal(hit.headers.get('etag'), missEtag, 'cached hit must preserve the origin ETag');
		const hitBody = await hit.text();
		assert.ok(hitBody.length > 0, 'cached hit must serve a real body, not an empty record');
		assert.equal(hitsFor('GET', originPath) - before, 1, 'conditional/cached hit must not re-invoke the source');
	});

	test('conditional request with matching If-None-Match returns 304 with no body', async (t) => {
		// The site-cache component proxies origin responses but does not implement
		// server-side If-None-Match / 304 conditional handling at the component layer:
		// the cache handlers build their own 200 Response and never compare a request's
		// If-None-Match against the stored ETag. This test is skipped until conditional
		// response support is added to the component.
		t.skip('site-cache component does not yet implement If-None-Match / 304 conditional responses');
	});

	test('cacheTag invalidation evicts the entry, then the source is re-invoked and re-cached', async () => {
		// cacheTag invalidation deletes matching records from the table directly (a deterministic
		// eviction), then the next request must re-invoke the SOURCE (origin hit increments) and
		// re-populate the cache — exercising the full miss -> source -> store -> hit cycle again.
		const reqPath = '/page/invalidation?sort=popular&page=1&filter=shirts';
		const originPath = '/page/invalidation';
		const cacheTag = `tag:${originPath.replace(/\//g, '_')}`;
		const before = hitsFor('GET', originPath);

		const miss = await harperGet(reqPath, PAGE_HEADERS);
		assert.equal(miss.headers.get('x-harper-cache'), 'miss');
		await miss.text();
		const hit = await harperGet(reqPath, PAGE_HEADERS);
		assert.equal(hit.headers.get('x-harper-cache'), 'hit');
		await hit.text();
		assert.equal(hitsFor('GET', originPath) - before, 1);

		const inv = await fetch(`${httpURL}/cache/invalidate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'authorization': authHeader },
			body: JSON.stringify({ type: 'cacheTag', cacheTag }),
		});
		assert.equal(inv.status, 200, `cacheTag invalidation failed: ${inv.status}`);

		// The deleted record forces a cache miss on the next request, which re-invokes the source.
		const deadline = Date.now() + 30_000;
		let sawMiss = false;
		while (Date.now() < deadline) {
			const res = await harperGet(reqPath, PAGE_HEADERS);
			await res.text();
			if (res.headers.get('x-harper-cache') === 'miss') {
				sawMiss = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		assert.ok(sawMiss, 'cacheTag invalidation should force a cache miss');
		assert.ok(hitsFor('GET', originPath) - before >= 2, 'source must be re-invoked after invalidation');

		const refreshed = await harperGet(reqPath, PAGE_HEADERS);
		assert.equal(refreshed.status, 200);
		assert.equal(refreshed.headers.get('x-harper-cache'), 'hit', 'cache should be re-populated after invalidation');
		await refreshed.text();
	});
});

import { SPECIAL_TTL } from '../resources/ttlRules.js';
import {
	buildDownstreamHeaders,
	buildUpstreamHeaders,
	cachePutObservabilityHeaders,
	cacheGetObservabilityHeaders,
} from '../util/headers.js';
import { classifyRequest, headerToCacheTags, isInvalidated } from '../util/cache.js';
import {
	METHODS_WITH_BODY,
	NO_BODY_RESPONSES,
	CACHE_CONFIG,
	resolveConfiguredOrigin,
	resolveOriginAuthHeader,
} from '../constants/index.js';
import { buildAPICacheKey } from '../util/cacheKeys.js';
import type { IncomingMessage } from 'http';
import { fetchFromOrigin } from '../util/originClient.js';
import { IncomingHttpHeaders } from 'undici/types/header.js';
import type { CacheContent } from '../types/graphql.js';

const { CacheContent: CacheContentTable } = databases.APICache;

const hasRequestBody = (request: IncomingMessage) => {
	const contentLength = request.headers['content-length'];
	if (contentLength && Number(contentLength) > 0) return true;
	return !!request.headers['transfer-encoding'];
};

const readNodeRequestBody = async (nodeRequest: any) => {
	if (!nodeRequest || nodeRequest.readableEnded) return Buffer.alloc(0);

	return await new Promise((resolve, reject) => {
		const chunks: Buffer<any>[] = [];
		nodeRequest.on('error', reject);
		nodeRequest.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		nodeRequest.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)));
	});
};

const readRequestBody = async (request: any) => {
	const nodeBody: any = await readNodeRequestBody(request._nodeRequest);
	if (nodeBody.length > 0) return nodeBody;

	if (!request || request.bodyUsed || typeof request.arrayBuffer !== 'function') {
		return Buffer.alloc(0);
	}

	try {
		const body = await request.arrayBuffer();
		return body.byteLength ? Buffer.from(body) : Buffer.alloc(0);
	} catch {
		return Buffer.alloc(0);
	}
};

const fetchFromCache = async (
	request: IncomingMessage,
	url: URL,
	upstreamHeaders: IncomingHttpHeaders,
	cacheInvalidations: Record<string, number>,
	startTime: number
) => {
	const cacheKey = buildAPICacheKey(request);

	// 1) Check cache
	const cacheResult: null | CacheContent = await CacheContentTable.get(cacheKey);
	if (cacheResult && !isInvalidated('api', cacheInvalidations, cacheResult.refreshedAt!, cacheResult.groupCode)) {
		let cachedBody: Uint8Array | null = null;
		try {
			cachedBody = await cacheResult.data.bytes();
		} catch (err) {
			console.error('Error reading API cache blob, falling back to origin', cacheKey, err);
		}

		if (cachedBody) {
			server.recordAnalytics(performance.now() - startTime, 'cache-hit', 'APICache');
			// cache hit
			return new Response(Buffer.from(cachedBody), {
				status: 200,
				headers: {
					'x-hdb': 'true',
					'x-hdb-cache': 'hit',
					...JSON.parse(cacheResult.headers ?? '{}'),
					...(request.headers['x-hdb-cache-debug'] ? cacheGetObservabilityHeaders(request, cacheKey, cacheResult) : {}),
				},
			});
		}
	}

	// 2) Miss → fetch from origin
	const init = { method: 'GET', headers: upstreamHeaders };
	const upstreamResp = await fetchFromOrigin(url, init);

	// prepare downstream headers/body
	const downstreamHeaders = buildDownstreamHeaders(upstreamResp.headers);

	// Read body once so we can build two Responses (one to return, one to cache)
	const bodyBuf = Buffer.from(await upstreamResp.arrayBuffer());

	const ttlConfig = classifyRequest(request, cacheKey);
	const shouldCache = upstreamResp.status === 200 && ttlConfig?.ruleId;

	const debugHeaders = cachePutObservabilityHeaders(request, ttlConfig, cacheKey);

	if (shouldCache) {
		let expiresAt: number | undefined = Date.now() + ttlConfig.ttlSeconds * 1000;
		if (ttlConfig.policy === SPECIAL_TTL.ORIGIN) {
			const originExpires = downstreamHeaders.get('expires')!;
			expiresAt = new Date(originExpires).getTime();
		} else if (ttlConfig.policy === SPECIAL_TTL.NEVER) {
			expiresAt = undefined;
		}

		const headersForCache = Object.fromEntries(
			Array.from(downstreamHeaders.entries()).filter(([k]) => k.toLowerCase() !== 'set-cookie')
		);

		if (bodyBuf.length) {
			const blob = await createBlob(bodyBuf);
			await CacheContentTable.put(
				cacheKey,
				{
					data: blob,
					headers: JSON.stringify(headersForCache),
					debugHeaders: JSON.stringify(debugHeaders),
					groupCode: ttlConfig.groupCode,
					refreshedAt: Date.now(),
					cacheTags: headerToCacheTags(new Headers(headersForCache)),
					url: url.href,
				},
				{
					expiresAt,
				}
			);
		}
	}

	if (request.headers['x-hdb-cache-debug']) {
		Object.entries(debugHeaders).forEach(([k, v]) => downstreamHeaders.set(k, v));
	}

	const body = !NO_BODY_RESPONSES.has(upstreamResp.status) ? bodyBuf : null;

	downstreamHeaders.set('x-hdb-cache', shouldCache ? 'miss' : 'no-cache');

	server.recordAnalytics(performance.now() - startTime, shouldCache ? 'cache-miss' : 'no-cache', 'APICache');

	const downstreamResponse = new Response(body, {
		status: upstreamResp.status,
		statusText: upstreamResp.statusText,
		headers: downstreamHeaders,
	});

	return downstreamResponse;
};

export const handleAPI = async (request: IncomingMessage, cacheInvalidations: Record<string, number>) => {
	const startTime = performance.now();
	const origin = resolveConfiguredOrigin('apiOrigin');

	let url = new URL(request.url!, origin);
	if (CACHE_CONFIG.apiPathReplacement) {
		url = new URL(
			request.url!.replace(CACHE_CONFIG.apiPathReplacement.search, CACHE_CONFIG.apiPathReplacement.replace),
			origin
		);
	}

	const upstreamHeaders = buildUpstreamHeaders(request.headers);
	const originAuthHeader = resolveOriginAuthHeader('apiOrigin');
	if (originAuthHeader) {
		upstreamHeaders[originAuthHeader.headerName] = originAuthHeader.token;
	}
	const method = (request.method || 'GET').toUpperCase();
	const incomingHasBody = METHODS_WITH_BODY.has(method) && hasRequestBody(request);

	// ---------- GET: try cache ----------
	if (method === 'GET' && request.headers['x-harper-cache-bypass'] !== 'true') {
		return fetchFromCache(request, url, upstreamHeaders, cacheInvalidations, startTime);
	}

	// ---------- proxy (no caching) ----------
	const init: RequestInit = { method, headers: upstreamHeaders as HeadersInit };
	if (incomingHasBody) {
		const requestBody = await readRequestBody(request);
		if (requestBody.length > 0) {
			// Use a replayable body source to avoid undici stream-source failures.
			init.body = requestBody;
		}
	}

	const response = await fetchFromOrigin(url, init);
	const headers = buildDownstreamHeaders(response.headers);

	server.recordAnalytics(performance.now() - startTime, 'no-cache', 'APICache');

	const body = !NO_BODY_RESPONSES.has(response.status) ? (response.body as BodyInit) : null;

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
};

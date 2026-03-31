import { Resource } from 'harperdb';
import { buildDownstreamHeaders, cachePutObservabilityHeaders, headerGet } from '../util/headers.js';
import { classifyRequest, headerToCacheTags, fetchCacheEntry, buildCacheResponse } from '../util/cache.js';
import { METHODS_WITH_BODY, NO_BODY_RESPONSES, CACHE_CONFIG } from '../constants/index.js';
import { buildAPICacheKey } from '../util/cacheKeys.js';
import { SPECIAL_TTL } from '../resources/ttlRules.js';
import {
	fetchFromOrigin,
	OriginErrorResponse,
	buildOriginUrl,
	buildUpstreamRequestHeaders,
} from '../util/originClient.js';
import type { TTLRuleMatchResult } from '../types/index.js';

const { CacheContent: APICacheTable } = databases.APICache;

// Set<string> keyed on cacheKey: the resource and the wrapper run in different request contexts
// (Harper request vs node IncomingMessage) so WeakMap on the request object isn't reliable here.
const missCacheKeys = new Set<string>();

const consumeWasMiss = (cacheKey: string): boolean => {
	const wasMiss = missCacheKeys.has(cacheKey);
	missCacheKeys.delete(cacheKey);
	return wasMiss;
};

const hasRequestBody = (request: any) => {
	const contentLength = headerGet(request.headers, 'content-length');
	if (contentLength && Number(contentLength) > 0) return true;
	return !!headerGet(request.headers, 'transfer-encoding');
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

/**
 * External data source for the APICache.CacheContent table.
 * Called by Harper on a cache miss; the returned record is stored automatically.
 */
export class APICacheSource extends Resource {
	async get() {
		const cacheKey = this.getId() as string;
		const request = this.request;
		const url = buildOriginUrl(request, CACHE_CONFIG.apiOrigin, CACHE_CONFIG.apiPathReplacement);

		const response = await fetchFromOrigin(url, {
			method: 'GET',
			headers: buildUpstreamRequestHeaders(request, 'apiOrigin'),
		});
		const downstreamHeaders = buildDownstreamHeaders(response.headers);

		if (!response.ok) {
			const body = NO_BODY_RESPONSES.has(response.status) ? null : response.body;
			throw new OriginErrorResponse(
				response.status,
				response.statusText,
				Object.fromEntries(downstreamHeaders.entries()),
				body
			);
		}

		const ttlConfig = classifyRequest(request, cacheKey) as TTLRuleMatchResult;
		const debugHeaders = cachePutObservabilityHeaders(request, ttlConfig, cacheKey);
		const blob = response.body ? createBlob(response.body, { saveBeforeCommit: true }) : null;

		missCacheKeys.add(cacheKey);

		return {
			data: blob,
			headers: JSON.stringify(Object.fromEntries(downstreamHeaders.entries())),
			debugHeaders: JSON.stringify(debugHeaders),
			groupCode: ttlConfig.groupCode,
			refreshedAt: Date.now(),
			cacheTags: headerToCacheTags(downstreamHeaders),
			url: url.href,
		};
	}
}

APICacheTable.sourcedFrom(APICacheSource);

const fetchCachedAPIResponse = async (
	request: any,
	cacheKey: string,
	cacheInvalidations: Record<string, number>,
	startTime: number
): Promise<Response> => {
	const entry = await fetchCacheEntry(APICacheTable, cacheKey, cacheInvalidations, 'api', startTime, 'APICache');

	if (entry instanceof Response) {
		return entry;
	}

	const wasMiss = consumeWasMiss(cacheKey);
	server.recordAnalytics(performance.now() - startTime, wasMiss ? 'cache-miss' : 'cache-hit', 'APICache');
	return buildCacheResponse(entry, request, cacheKey, wasMiss ? 'miss' : 'hit');
};

export const handleAPI = async (request: any, cacheInvalidations: Record<string, number>) => {
	const startTime = performance.now();
	const method = (request.method || 'GET').toUpperCase();
	const bypassHeader = headerGet(request.headers, 'x-harper-cache-bypass');

	if (method === 'GET' && bypassHeader !== 'true') {
		const cacheKey = buildAPICacheKey(request);
		const ttlConfig = classifyRequest(request, cacheKey);
		if (ttlConfig?.ruleId && ttlConfig.policy !== SPECIAL_TTL.NO_CACHE) {
			return fetchCachedAPIResponse(request, cacheKey, cacheInvalidations, startTime);
		}
	}

	// Proxy path: non-GET, bypass, or no matching TTL rule
	const url = buildOriginUrl(request, CACHE_CONFIG.apiOrigin, CACHE_CONFIG.apiPathReplacement);
	const upstreamHeaders = buildUpstreamRequestHeaders(request, 'apiOrigin');
	const incomingHasBody = METHODS_WITH_BODY.has(method) && hasRequestBody(request);
	const init: RequestInit = { method, headers: upstreamHeaders as HeadersInit };

	if (incomingHasBody) {
		const requestBody = await readRequestBody(request);
		if (requestBody.length > 0) {
			init.body = requestBody;
		}
	}

	const response = await fetchFromOrigin(url, init);
	const headers = buildDownstreamHeaders(response.headers);

	server.recordAnalytics(performance.now() - startTime, 'no-cache', 'APICache');

	const body = !NO_BODY_RESPONSES.has(response.status) ? (response.body as BodyInit) : null;
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
};

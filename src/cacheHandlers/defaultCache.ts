import { Resource } from 'harper';
import { classifyRequest, headerToCacheTags, fetchCacheEntry, buildCacheResponse } from '../util/cache.js';
import { buildPageCacheKey } from '../util/cacheKeys.js';
import { buildDownstreamHeaders, cachePutObservabilityHeaders } from '../util/headers.js';
import { CACHE_CONFIG, NO_BODY_RESPONSES, HANDLER_TIMEOUT_MS } from '../constants/index.js';
import type { TTLRuleMatchResult } from '../types/index.js';
import {
	fetchFromOrigin,
	OriginErrorResponse,
	buildOriginUrl,
	buildUpstreamRequestHeaders,
} from '../util/originClient.js';

export const { CacheContent: CacheContentTable } = databases.DefaultCache;

// Re-exports for index.ts orchestration
export { buildPageCacheKey, classifyRequest };

// WeakMap keyed on the request object so concurrent requests for the same cache key don't interfere
const requestMissMap = new WeakMap<object, true>();

const consumeWasMiss = (request: object): boolean => {
	const wasMiss = requestMissMap.has(request);
	requestMissMap.delete(request);
	return wasMiss;
};

/**
 * External data source for the DefaultCache.CacheContent table.
 * Called by Harper on a cache miss; the returned record is stored automatically.
 */
export class DefaultCacheSource extends Resource {
	static async get(target: any, context: any) {
		const cacheKey = target.id as string;
		const request = context.request;
		const url = buildOriginUrl(request, CACHE_CONFIG.defaultOrigin, CACHE_CONFIG.defaultPathReplacement);

		logger.info('Fetching from origin', CACHE_CONFIG.defaultOrigin, request.url);

		const response = await fetchFromOrigin(url, {
			method: 'GET',
			headers: buildUpstreamRequestHeaders(request, 'defaultOrigin'),
		});
		const responseHeaderObj = buildDownstreamHeaders(response.headers);

		if (!response.ok) {
			const body = NO_BODY_RESPONSES.has(response.status) ? null : response.body;
			throw new OriginErrorResponse(
				response.status,
				response.statusText,
				Object.fromEntries(responseHeaderObj.entries()),
				body
			);
		}

		const ttlConfig = classifyRequest(request, cacheKey) as TTLRuleMatchResult;
		const debugHeaders = cachePutObservabilityHeaders(request, ttlConfig, cacheKey);
		const blob = response.body ? createBlob(response.body, { saveBeforeCommit: true }) : null;

		// Mark this request as a cache miss so the caller can set the correct response headers
		requestMissMap.set(request, true);

		return {
			data: blob,
			headers: JSON.stringify(Object.fromEntries(responseHeaderObj.entries())),
			debugHeaders: JSON.stringify(debugHeaders),
			groupCode: ttlConfig.groupCode,
			refreshedAt: Date.now(),
			cacheTags: headerToCacheTags(responseHeaderObj),
			url: url.href,
		};
	}
}

CacheContentTable.sourcedFrom(DefaultCacheSource);

export const fetchCachedResponse = async (
	request: any,
	cacheKey: string,
	cacheInvalidations: Record<string, number>,
	startTime: number
): Promise<Response> => {
	const entry = await fetchCacheEntry(CacheContentTable, cacheKey, cacheInvalidations, 'page');

	const elapsed = () => Math.min(performance.now() - startTime, HANDLER_TIMEOUT_MS);

	if (entry instanceof Response) {
		server.recordAnalytics(elapsed(), 'http-no-cache', 'DefaultCache');
		return entry;
	}

	const wasMiss = consumeWasMiss(request);
	server.recordAnalytics(elapsed(), wasMiss ? 'cache-miss' : 'cache-hit', 'DefaultCache');
	return buildCacheResponse(entry, request, cacheKey, wasMiss ? 'miss' : 'hit');
};

/** Direct origin passthrough for non-cacheable requests — no table interaction. */
export const originPassthrough = async (request: any, startTime: number): Promise<Response> => {
	const url = buildOriginUrl(request, CACHE_CONFIG.defaultOrigin, CACHE_CONFIG.defaultPathReplacement);
	const response = await fetchFromOrigin(url, {
		method: 'GET',
		headers: buildUpstreamRequestHeaders(request, 'defaultOrigin'),
	});
	const responseHeaderObj = buildDownstreamHeaders(response.headers);

	server.recordAnalytics(Math.min(performance.now() - startTime, HANDLER_TIMEOUT_MS), 'http-no-cache', 'DefaultCache');
	const body = NO_BODY_RESPONSES.has(response.status) ? null : response.body;
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaderObj,
	});
};

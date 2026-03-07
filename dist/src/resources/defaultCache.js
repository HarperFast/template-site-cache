import cacheConfig from '../../cacheConfiguration.json' with { type: 'json' };
import { SPECIAL_TTL } from './cacheConfig.js';
import { classifyRequest, headerToCacheTags, isInvalidated } from '../util/cache.js';
import { buildPageCacheKey } from '../util/cacheKeys.js';
import { cacheGetObservabilityHeaders, cachePutObservabilityHeaders, normalizeHeaders } from '../util/headers.js';
import { Resource, logger, createBlob, databases, server } from 'harperdb';
const { CacheContent: CacheContentTable } = databases.DefaultCache;
const originFetch = async (request, cacheKey, ttlConfig, startTime) => {
	const path = request.url;
	const origin = cacheConfig.defaultOrigin[process.env.ENVIRONMENT]; // get the origin URL from the config file
	logger.info('Fetching from origin', origin, path);
	const url = new URL(path, origin);
	const response = await fetch(url); // Fetch the page content
	// dont cache an unsuccessful response from origin
	if (!response.ok) {
		logger.warn('Skipped caching for: ', path);
		server.recordAnalytics(performance.now() - startTime, 'no-cache', 'DefaultCache');
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: { 'content-type': 'text/html' },
		});
	}
	const cacheClone = response.clone();
	const normalizedHeaders = normalizeHeaders(cacheClone.headers);
	const responseHeaderObj = new Headers(normalizedHeaders);
	// Only cache if we have a TTL rule
	if (ttlConfig?.ruleId) {
		const debugHeaders = cachePutObservabilityHeaders(request, ttlConfig, cacheKey);
		if (request.headers.get('x-hdb-cache-debug')) {
			Object.entries(debugHeaders).forEach(([k, v]) => responseHeaderObj.set(k, v));
		}
		let expiresAt = Date.now() + ttlConfig.ttlSeconds * 1000;
		if (ttlConfig.policy === SPECIAL_TTL.ORIGIN) {
			expiresAt = new Date(request.headers.get('expires')).getTime();
		} else if (ttlConfig.policy === SPECIAL_TTL.NEVER) {
			expiresAt = undefined;
		}
		const cacheHeaders = new Headers(normalizedHeaders);
		cacheHeaders.delete('set-cookie');
		const blob = await createBlob(cacheClone.body);
		await blob.save(CacheContentTable);
		await CacheContentTable.put(
			cacheKey,
			{
				pageContents: blob,
				headers: JSON.stringify(Object.fromEntries(cacheHeaders.entries())),
				debugHeaders: JSON.stringify(debugHeaders),
				groupCode: ttlConfig.groupCode,
				refreshedAt: Date.now(),
				cacheTags: headerToCacheTags(cacheHeaders),
				url: url.href,
			},
			{
				expiresAt,
			}
		);
	}
	responseHeaderObj.set('x-hdb-cache', 'miss');
	responseHeaderObj.set('x-hdb', 'true');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaderObj,
	});
};
const cacheFetch = async (request, cacheKey) => {
	logger.info('Fetching from cache', cacheKey);
	const cacheResult = await CacheContentTable.get(cacheKey);
	if (!cacheResult) {
		logger.info('Cache miss', cacheKey);
		return null;
	}
	let htmlContent;
	try {
		// Defensive read of the blob
		htmlContent = await cacheResult.data.bytes();
	} catch (err) {
		logger.error('Error reading blob bytes for cache key', cacheKey, err);
		try {
			await CacheContentTable.delete(cacheKey);
			logger.warn('Corrupted cache entry removed', cacheKey);
		} catch (deleteErr) {
			logger.error('Failed to delete corrupted cache entry', cacheKey, deleteErr);
		}
		return null; // fail gracefully
	}
	logger.info('Cache hit', cacheKey);
	return {
		response: new Response(htmlContent, {
			status: 200,
			headers: {
				'x-hdb': 'true',
				'x-hdb-cache': 'hit',
				...JSON.parse(cacheResult.headers ?? '{}'),
				...(request.headers.get('x-hdb-cache-debug')
					? cacheGetObservabilityHeaders(request, cacheKey, cacheResult)
					: {}),
			},
		}),
		refreshedAt: cacheResult.refreshedAt,
		groupCode: cacheResult.groupCode,
	};
};
export class DefaultCache extends Resource {
	async get(cacheInvalidations) {
		const request = this.getContext()._nodeRequest;
		const startTime = performance.now();
		const cacheKey = buildPageCacheKey(request);
		const ttlConfig = classifyRequest(request, cacheKey);
		const isCacheable = !!ttlConfig?.ruleId && request.headers.get('x-harper-cache-bypass') !== 'true';
		logger.info(
			`Built cache key ${cacheKey} for path: ${request.url}. Determined to be ${isCacheable ? 'cacheable' : 'not cacheable'}.`
		);
		const cacheResult = isCacheable ? await cacheFetch(request, cacheKey) : null;
		if (cacheResult && !isInvalidated('page', cacheResult.groupCode, cacheResult.refreshedAt, cacheInvalidations)) {
			server.recordAnalytics(performance.now() - startTime, 'cache-hit', 'DefaultCache');
			return cacheResult.response;
		}
		const result = await originFetch(request, cacheKey, ttlConfig, startTime);
		server.recordAnalytics(performance.now() - startTime, 'cache-miss', 'DefaultCache');
		return result;
	}
}

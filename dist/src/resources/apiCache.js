import cacheConfiguration from '../../cacheConfiguration.json' with { type: 'json' };
import { SPECIAL_TTL } from './cacheConfig.js';
import {
	buildDownstreamHeaders,
	buildUpstreamHeaders,
	cachePutObservabilityHeaders,
	cacheGetObservabilityHeaders,
} from '../util/headers.js';
import { classifyRequest, headerToCacheTags, isInvalidated } from '../util/cache.js';
import { NO_BODY_RESPONSES } from '../constants/index.js';
import { buildAPICacheKey } from '../util/cacheKeys.js';
import { Resource, server, databases } from 'harperdb';
const { CacheContent: CacheContentTable } = databases.APICache;
export class APICache extends Resource {
	async get(cacheInvalidations) {
		const startTime = performance.now();
		const request = this.getContext()._nodeRequest;
		const origin = cacheConfiguration.apiOrigin[process.env.ENVIRONMENT];
		let url = new URL(request.url, origin);
		if (cacheConfiguration.apiPathReplacement) {
			url = new URL(
				request.url.replace(
					cacheConfiguration.apiPathReplacement.search,
					cacheConfiguration.apiPathReplacement.replace
				),
				origin
			);
		}
		const upstreamHeaders = buildUpstreamHeaders(request.headers);
		const method = (request.method || 'GET').toUpperCase();
		// ---------- GET: try cache ----------
		if (method === 'GET' && request.headers.get('x-harper-cache-bypass') !== 'true') {
			const cacheKey = buildAPICacheKey(request);
			// 1) Check cache
			const cacheResult = await CacheContentTable.get(cacheKey);
			if (cacheResult && !isInvalidated('api', cacheResult.groupCode, cacheResult.refreshedAt, cacheInvalidations)) {
				server.recordAnalytics(performance.now() - startTime, 'cache-hit', 'APICache');
				// cache hit
				return new Response(cacheResult.data, {
					status: 200,
					headers: {
						'x-hdb': 'true',
						'x-hdb-cache': 'hit',
						...JSON.parse(cacheResult.headers ?? '{}'),
						...(request.headers.get('x-hdb-cache-debug')
							? cacheGetObservabilityHeaders(request, cacheKey, cacheResult)
							: {}),
					},
				});
			}
			// 2) Miss → fetch from origin
			const init = { method, headers: upstreamHeaders };
			const upstreamResp = await fetch(url, init);
			// prepare downstream headers/body
			const downstreamHeaders = buildDownstreamHeaders(upstreamResp.headers);
			// Read body once so we can build two Responses (one to return, one to cache)
			const bodyBuf = await upstreamResp.arrayBuffer();
			const ttlConfig = classifyRequest(request, cacheKey);
			const shouldCache = upstreamResp.status === 200 && ttlConfig?.ruleId;
			const debugHeaders = cachePutObservabilityHeaders(request, ttlConfig, cacheKey);
			if (shouldCache) {
				let expiresAt = Date.now() + ttlConfig.ttlSeconds * 1000;
				if (ttlConfig.policy === SPECIAL_TTL.ORIGIN) {
					expiresAt = new Date(request.headers.get('expires')).getTime();
				} else if (ttlConfig.policy === SPECIAL_TTL.NEVER) {
					expiresAt = undefined;
				}
				const headersForCache = Object.fromEntries(
					Array.from(downstreamHeaders.entries()).filter(([k]) => k.toLowerCase() !== 'set-cookie')
				);
				await CacheContentTable.put(
					cacheKey,
					{
						data: bodyBuf.slice(0),
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
			if (request.headers.get('x-hdb-cache-debug')) {
				Object.entries(debugHeaders).forEach(([k, v]) => downstreamHeaders.set(k, v));
			}
			const body = !NO_BODY_RESPONSES.has(upstreamResp.status) ? bodyBuf.slice(0) : null;
			downstreamHeaders.set('x-hdb-cache', shouldCache ? 'miss' : 'no-cache');
			server.recordAnalytics(performance.now() - startTime, shouldCache ? 'cache-miss' : 'no-cache', 'APICache');
			const downstreamResponse = new Response(body, {
				status: upstreamResp.status,
				statusText: upstreamResp.statusText,
				headers: downstreamHeaders,
			});
			return downstreamResponse;
		}
		// ---------- proxy (no caching) ----------
		const init = { method, headers: upstreamHeaders };
		if (method !== 'HEAD') {
			init.body = request._nodeRequest;
			// init.duplex = 'half'; FIXME: is this needed??
		}
		const response = await fetch(url, init);
		const headers = buildDownstreamHeaders(response.headers);
		server.recordAnalytics(performance.now() - startTime, 'no-cache', 'APICache');
		const body = !NO_BODY_RESPONSES.has(response.status) ? response.body : null;
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
}

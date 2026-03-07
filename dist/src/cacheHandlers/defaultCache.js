import { SPECIAL_TTL } from '../resources/ttlRules.js';
import { classifyRequest, headerToCacheTags, isInvalidated } from '../util/cache.js';
import { buildPageCacheKey } from '../util/cacheKeys.js';
import { buildUpstreamHeaders, cacheGetObservabilityHeaders, cachePutObservabilityHeaders, normalizeHeaders, } from '../util/headers.js';
import { CACHE_CONFIG, resolveConfiguredOrigin, resolveOriginAuthHeader } from '../constants/index.js';
import { fetchFromOrigin } from '../util/originClient.js';
const { CacheContent: CacheContentTable } = databases.DefaultCache;
const originFetch = async (request, cacheKey, ttlConfig, startTime) => {
    const path = request.url;
    const origin = resolveConfiguredOrigin('defaultOrigin'); // get the origin URL from the config file
    logger.info('Fetching from origin', origin, path);
    let url = new URL(path, origin);
    if (CACHE_CONFIG.defaultPathReplacement) {
        url = new URL(request.url.replace(CACHE_CONFIG.defaultPathReplacement.search, CACHE_CONFIG.defaultPathReplacement.replace), origin);
    }
    const upstreamHeaders = buildUpstreamHeaders(request.headers);
    const originAuthHeader = resolveOriginAuthHeader('defaultOrigin');
    if (originAuthHeader) {
        upstreamHeaders[originAuthHeader.headerName] = originAuthHeader.token;
    }
    const response = await fetchFromOrigin(url, { method: 'GET', headers: upstreamHeaders }); // Fetch the page content
    const bodyBuffer = response.body ? Buffer.from(await response.arrayBuffer()) : null;
    // dont cache an unsuccessful response from origin
    if (!response.ok) {
        logger.warn('Skipped caching for: ', path);
        server.recordAnalytics(performance.now() - startTime, 'http-no-cache', 'PageCache');
        return new Response(bodyBuffer, {
            status: response.status,
            statusText: response.statusText,
            headers: { 'content-type': 'text/html' },
        });
    }
    const normalizedHeaders = normalizeHeaders(response.headers);
    const responseHeaderObj = new Headers(normalizedHeaders);
    const shouldCache = !!ttlConfig?.ruleId && ttlConfig?.policy !== SPECIAL_TTL.NO_CACHE;
    // Only cache if we have a TTL rule
    if (shouldCache) {
        const debugHeaders = cachePutObservabilityHeaders(request, ttlConfig, cacheKey);
        if (request.headers.get('x-hdb-cache-debug')) {
            Object.entries(debugHeaders).forEach(([k, v]) => responseHeaderObj.set(k, v));
        }
        let expiresAt = Date.now() + ttlConfig.ttlSeconds * 1000;
        if (ttlConfig.policy === SPECIAL_TTL.ORIGIN) {
            const expires = responseHeaderObj.get('expires');
            if (expires)
                expiresAt = new Date(expires).getTime();
            else
                expiresAt = undefined;
        }
        else if (ttlConfig.policy === SPECIAL_TTL.NEVER) {
            expiresAt = undefined;
        }
        const cacheHeaders = new Headers(normalizedHeaders);
        cacheHeaders.delete('set-cookie');
        if (bodyBuffer) {
            const blob = await createBlob(bodyBuffer);
            await CacheContentTable.put(cacheKey, {
                data: blob,
                headers: JSON.stringify(Object.fromEntries(cacheHeaders.entries())),
                debugHeaders: JSON.stringify(debugHeaders),
                groupCode: ttlConfig.groupCode,
                refreshedAt: Date.now(),
                cacheTags: headerToCacheTags(cacheHeaders),
                url: url.href,
            }, {
                expiresAt,
            });
        }
    }
    responseHeaderObj.set('x-hdb-cache', shouldCache ? 'miss' : 'no-cache');
    responseHeaderObj.set('x-hdb', 'true');
    return new Response(bodyBuffer ?? null, {
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
    }
    catch (err) {
        logger.error('Error reading blob bytes for cache key', cacheKey, err);
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
export const handleDefault = async (request, cacheInvalidations) => {
    const startTime = performance.now();
    const cacheKey = buildPageCacheKey(request);
    const ttlConfig = classifyRequest(request, cacheKey);
    const isCacheable = !!ttlConfig?.ruleId && request.headers['x-harper-cache-bypass'] !== 'true';
    logger.info(`Built cache key ${cacheKey} for path: ${request.url}. Determined to be ${isCacheable ? 'cacheable' : 'not cacheable'}.`);
    const cacheResult = isCacheable ? await cacheFetch(request, cacheKey) : null;
    if (cacheResult && !isInvalidated('page', cacheInvalidations, cacheResult.refreshedAt, cacheResult.groupCode)) {
        server.recordAnalytics(performance.now() - startTime, 'cache-hit', 'DefaultCache');
        return cacheResult.response;
    }
    const result = await originFetch(request, cacheKey, ttlConfig, startTime);
    server.recordAnalytics(performance.now() - startTime, 'cache-miss', 'DefaultCache');
    return result;
};

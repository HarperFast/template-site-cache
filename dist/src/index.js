import { handleAPI } from './cacheHandlers/apiCache.js';
import { handleDefault } from './cacheHandlers/defaultCache.js';
import { TTLRules } from './resources/ttlRules.js';
import { Invalidate } from './resources/cacheInvalidation.js';
import { RESERVED_PATHS, CACHE_INVALIDATIONM_KEY, CACHE_CONFIG } from './constants/index.js';
export const cache = { ttlConfig: TTLRules, invalidate: Invalidate };
let cacheInvalidations = {};
console.log('Cache server starting...');
server.http(async (request, next) => {
    if (RESERVED_PATHS.includes(request.url)) {
        return next(request);
    }
    // const auth = request.headers.get('x-hdb-authorization');
    // const { username, password } = decodeAuthHeader(auth);
    // const user = await server.authenticateUser(username, password);
    // if (ALLOWED_ROLES.includes(user.role)) {
    // 	return new Response('Unauthorized', { status: 403 });
    // }
    const apiHeaderKey = CACHE_CONFIG.apiHeader?.key ?? '';
    const apiHeader = request.headers.get(apiHeaderKey) ?? request.headers.get(apiHeaderKey.toLowerCase());
    if (apiHeader === CACHE_CONFIG.apiHeader?.value || request.url.includes(CACHE_CONFIG.apiPathPrefix)) {
        return handleAPI(request, cacheInvalidations);
    }
    return handleDefault(request, cacheInvalidations);
}, { runFirst: true });
const { CacheInvalidation: CacheInvalidationTable } = databases.CacheManagement;
const initializeCacheInvalidationSubscription = async () => {
    const setCacheInvalidations = (timestamps) => {
        if (timestamps && typeof timestamps === 'object') {
            cacheInvalidations = timestamps;
        }
    };
    try {
        const currentInvalidations = await CacheInvalidationTable.get(CACHE_INVALIDATIONM_KEY);
        setCacheInvalidations(currentInvalidations?.timestamps);
        const subscription = await CacheInvalidationTable.subscribe({ omitCurrent: true });
        subscription.on('data', (event) => {
            if (event.id !== CACHE_INVALIDATIONM_KEY)
                return;
            setCacheInvalidations(event.value?.timestamps);
        });
        subscription.on('error', (error) => {
            logger.error('Cache invalidation subscription error', error);
        });
    }
    catch (error) {
        logger.error('Failed to initialize cache invalidation subscription', error);
    }
};
void initializeCacheInvalidationSubscription();

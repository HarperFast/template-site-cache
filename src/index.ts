import { handleAPI } from './cacheHandlers/apiCache.js';
import { handleDefault } from './cacheHandlers/defaultCache.js';
import { TTLRules } from './resources/ttlRules.js';
import { Invalidate } from './resources/cacheInvalidation.js';
import type { CacheInvalidation } from './types/graphql.js';
import { RESERVED_PATHS, CACHE_INVALIDATIONM_KEY, CACHE_CONFIG, ALLOWED_ROLES } from './constants/index.js';
import { decodeAuthHeader } from './util/auth.js';

export const cache = { ttlConfig: TTLRules, invalidate: Invalidate };

let cacheInvalidations: Record<string, number> = {};

server.http(
	async (request: any, next: (...args: unknown[]) => unknown) => {
		if (RESERVED_PATHS.includes(request.url)) {
			return next(request);
		}

		const auth = request.headers.get('authorization');
		const { username, password } = decodeAuthHeader(auth);
		const user = await server.authenticateUser(username, password);

		if (!ALLOWED_ROLES.includes(user.role.role)) {
			return new Response('Unauthorized', { status: 403 });
		}

		const apiHeaderKey = CACHE_CONFIG.apiHeader?.key ?? '';
		const apiHeader = request.headers.get(apiHeaderKey) ?? request.headers.get(apiHeaderKey.toLowerCase());
		if (apiHeader === CACHE_CONFIG.apiHeader?.value || request.url.includes(CACHE_CONFIG.apiPathPrefix)) {
			return handleAPI(request, cacheInvalidations);
		}

		return handleDefault(request, cacheInvalidations);
	},
	{ runFirst: true }
);

const { CacheInvalidation: CacheInvalidationTable } = databases.CacheManagement;

const initializeCacheInvalidationSubscription = async () => {
	const setCacheInvalidations = (timestamps?: CacheInvalidation['timestamps']) => {
		if (timestamps && typeof timestamps === 'object') {
			cacheInvalidations = timestamps as Record<string, number>;
		}
	};

	try {
		const currentInvalidations = await CacheInvalidationTable.get(CACHE_INVALIDATIONM_KEY);
		setCacheInvalidations(currentInvalidations?.timestamps);

		const subscription = await CacheInvalidationTable.subscribe({ omitCurrent: true });
		subscription.on('data', (event: { id: number; type: string; value?: CacheInvalidation }) => {
			if (event.id !== CACHE_INVALIDATIONM_KEY) return;
			setCacheInvalidations(event.value?.timestamps);
		});

		subscription.on('error', (error: unknown) => {
			logger.error('Cache invalidation subscription error', error);
		});
	} catch (error) {
		logger.error('Failed to initialize cache invalidation subscription', error);
	}
};

void initializeCacheInvalidationSubscription();

import { handleAPI } from './cacheHandlers/apiCache.js';
import {
	buildPageCacheKey,
	classifyRequest,
	fetchCachedResponse,
	originPassthrough,
} from './cacheHandlers/defaultCache.js';
import { TTLRules, SPECIAL_TTL } from './resources/ttlRules.js';
import { Invalidate } from './resources/cacheInvalidation.js';
import type { CacheInvalidation } from './types/graphql.js';
import { RESERVED_PATHS, CACHE_INVALIDATION_KEY, CACHE_CONFIG, ALLOWED_ROLES_CACHE, HANDLER_TIMEOUT_MS } from './constants/index.js';
import { decodeAuthHeader } from './util/auth.js';

export const cache = { ttlConfig: TTLRules, invalidate: Invalidate };

let cacheInvalidations: Record<string, number> = {};

const { CacheInvalidation: CacheInvalidationTable } = databases.CacheManagement;

const initializeCacheInvalidationSubscription = async () => {
	const setCacheInvalidations = (timestamps?: CacheInvalidation['timestamps']) => {
		if (timestamps && typeof timestamps === 'object') {
			cacheInvalidations = timestamps as Record<string, number>;
		}
	};

	try {
		const currentInvalidations = await CacheInvalidationTable.get(CACHE_INVALIDATION_KEY);
		setCacheInvalidations(currentInvalidations?.timestamps);

		const subscription = await CacheInvalidationTable.subscribe({ omitCurrent: true });
		subscription.on('data', (event: { id: number; type: string; value?: CacheInvalidation }) => {
			if (event.id !== CACHE_INVALIDATION_KEY) return;
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


const handleRequest = async (request: any) => {
	const auth = request.headers.get('authorization');
	let user;
	try {
		const { username, password } = decodeAuthHeader(auth);
		user = await server.authenticateUser(username, password);
	} catch {
		return new Response('Unauthenticated', { status: 401 });
	}

	if (!ALLOWED_ROLES_CACHE.includes(user.role.role)) {
		return new Response('Unauthorized', { status: 403 });
	}

	const apiHeaderKey = CACHE_CONFIG.apiHeader?.key ?? '';
	const apiHeader = request.headers.get(apiHeaderKey) ?? request.headers.get(apiHeaderKey.toLowerCase());
	if (apiHeader === CACHE_CONFIG.apiHeader?.value || request.url.includes(CACHE_CONFIG.apiPathPrefix)) {
		return handleAPI(request, cacheInvalidations);
	}

	const startTime = performance.now();
	const cacheKey = buildPageCacheKey(request);
	const ttlConfig = classifyRequest(request, cacheKey);
	const isCacheable =
		!!ttlConfig?.ruleId &&
		ttlConfig.policy !== SPECIAL_TTL.NO_CACHE &&
		request.headers.get('x-harper-cache-bypass') !== 'true';

	if (!isCacheable) {
		return originPassthrough(request, startTime);
	}

	return fetchCachedResponse(request, cacheKey, cacheInvalidations, startTime);
};

/**
 * Main entry point for handling incoming HTTP requests.
 */
server.http(
	async (request: any, next: (...args: unknown[]) => unknown) => {
		if (RESERVED_PATHS.includes(request.url)) {
			return next(request);
		}

		let timeoutId!: ReturnType<typeof setTimeout>;
		const timeoutPromise = new Promise<Response>((resolve) => {
			timeoutId = setTimeout(
				() => resolve(new Response('Gateway Timeout', { status: 504, statusText: 'Gateway Timeout' })),
				HANDLER_TIMEOUT_MS
			);
		});

		try {
			return await Promise.race([handleRequest(request), timeoutPromise]);
		} finally {
			clearTimeout(timeoutId);
		}
	},
	{ runFirst: true }
);

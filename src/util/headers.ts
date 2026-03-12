import type { IncomingHttpHeaders, IncomingMessage } from 'http';

const HOP_BY_HOP = new Set([
	'connection',
	'host',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

export const buildUpstreamHeaders = (headers: IncomingHttpHeaders) => {
	for (const key of Object.keys(headers)) {
		const lowerKey = key.toLowerCase();
		if (HOP_BY_HOP.has(lowerKey) || lowerKey.startsWith(':')) {
			delete headers[key];
		}
	}
	return headers;
};

export const buildDownstreamHeaders = (upstreamHeaders: any) => {
	const out = new Headers(upstreamHeaders);
	for (const k of [...out.keys()]) {
		if (HOP_BY_HOP.has(k.toLowerCase())) out.delete(k);
	}
	out.delete('accept-encoding');
	out.delete('content-length');
	out.set('x-hdb', 'true');
	return out;
};

/**
 * case-insensitive header get (works with Fetch Headers or plain object)
 *
 * @param {object} headers
 * @param {string} key
 * @returns
 */
export const headerGet = (headers: any, key: string) => {
	if (!headers || !key) return '';
	if (headers.get) return headers.get(key) || headers.get(String(key).toLowerCase()) || '';
	key = String(key);
	return headers[key] || headers[key.toLowerCase()] || '';
};

/* --------------------------------------------- */
// ----- headers for cache observability -------
/* --------------------------------------------- */
/**
 * Returns a set of headers useful for observability about caching decisions
 * These headers can be added to the response to provide insights into caching behavior.
 */
export const cachePutObservabilityHeaders = (req: IncomingMessage, ruleMeta: any, cacheKey: string) => ({
	'x-hdb-cache-path': req.url,
	'x-hdb-cache-rule': ruleMeta?.ruleName ? String(ruleMeta.ruleName) : 'none',
	'x-hdb-cache-rule-id': ruleMeta?.ruleId ? String(ruleMeta.ruleId) : '',
	'x-hdb-cache-policy': ruleMeta ? String(ruleMeta.policy) : 'none', // ttl | origin_expires | never | non)
	'x-hdb-cache-ttl': ruleMeta?.ttlSeconds ? String(ruleMeta.ttlSeconds) : '0',
	'x-hdb-cache-bucket': ruleMeta?.bucketPrefix ? ruleMeta.bucketPrefix : '',
	'x-hdb-cache-pattern': ruleMeta?.matchedPattern ? ruleMeta.matchedPattern : '',
	'x-hdb-cache-key': cacheKey,
});

/**
 * Returns a set of headers useful for observability about cached responses
 *
 * @param {object} req - fetch like request object
 * @param {string} cacheKey
 * @param {object} cacheRecord - harper DB cache record object
 * @returns
 */
export const cacheGetObservabilityHeaders = (req: IncomingMessage, cacheKey: string, cacheRecord: any) => ({
	...JSON.parse(cacheRecord?.debugHeaders ?? '{}'),
	'x-hdb-cache-path': req.url,
	'x-hdb-cache-key': cacheKey,
	'x-hdb-cache-ttl-remaining-sec': (cacheRecord.getMetadata().expiresAt - Date.now()) / 1000,
});

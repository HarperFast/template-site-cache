/**
 * Converts headers to a plain object and removes certain headers that should not be cached.
 */
export const normalizeHeaders = (headers) => {
    const isPlainObject = Object.getPrototypeOf(headers) === Object.prototype;
    if (isPlainObject) {
        const normalized = { ...headers };
        delete normalized['accept-encoding'];
        delete normalized['content-encoding'];
        delete normalized['transfer-encoding'];
        normalized['x-hdb'] = 'true';
        return normalized;
    }
    const normalized = {};
    for (const [key, value] of headers.entries()) {
        if (key.toLowerCase() === 'accept-encoding')
            continue;
        if (key.toLowerCase() === 'content-encoding')
            continue;
        if (key.toLowerCase() === 'transfer-encoding')
            continue;
        normalized[key] = value;
    }
    normalized['x-hdb'] = 'true';
    return normalized;
};
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
export const buildUpstreamHeaders = (headers) => {
    for (const key of Object.keys(headers)) {
        const lowerKey = key.toLowerCase();
        if (HOP_BY_HOP.has(lowerKey) || lowerKey.startsWith(':')) {
            delete headers[key];
        }
    }
    return headers;
};
export const buildDownstreamHeaders = (upstreamHeaders) => {
    const out = new Headers(upstreamHeaders);
    // Always drop hop-by-hop
    for (const k of [...out.keys()]) {
        if (HOP_BY_HOP.has(k.toLowerCase()))
            out.delete(k);
    }
    // If undici auto-decompressed, remove misleading headers
    out.delete('content-encoding');
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
export const headerGet = (headers, key) => {
    if (!headers || !key)
        return '';
    if (headers.get)
        return headers.get(key) || headers.get(String(key).toLowerCase()) || '';
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
export const cachePutObservabilityHeaders = (req, ruleMeta, cacheKey) => ({
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
export const cacheGetObservabilityHeaders = (req, cacheKey, cacheRecord) => ({
    ...JSON.parse(cacheRecord?.debugHeaders ?? '{}'),
    'x-hdb-cache-path': req.url,
    'x-hdb-cache-key': cacheKey,
    'x-hdb-cache-ttl-remaining-sec': (cacheRecord.getMetadata().expiresAt - Date.now()) / 1000,
});

import { KEY_OVERFLOW, CACHE_CONFIG } from '../constants/index.js';
import crypto from 'crypto';
const enc = (s) => encodeURIComponent(String(s));
const sortEntriesByKey = (entries) => entries.sort((a, b) => a[0].localeCompare(b[0]));
const joinPairs = (entries) => sortEntriesByKey(entries)
    .map(([k, vals]) => `${enc(k)}=${vals.map(enc).join(',')}`)
    .join('&');
const assembleCacheKey = (path, headerEntries = [], queryEntries = [], cookieEntries = []) => {
    let normalizedPath = path.toLowerCase();
    if (!path.endsWith('/')) {
        normalizedPath = `${normalizedPath}/`;
    }
    const parts = [
        `p=${normalizedPath}`,
        headerEntries.length ? `h=${joinPairs(headerEntries)}` : null,
        cookieEntries.length ? `c=${joinPairs(cookieEntries)}` : null,
        queryEntries.length ? `q=${joinPairs(queryEntries)}` : null,
    ].filter(Boolean);
    let cacheKey = parts.join('|');
    if (cacheKey.length > KEY_OVERFLOW) {
        // Harper's max key size is 1936 bytes, so we need to hash the key if it is too long
        cacheKey = cacheKey.slice(0, KEY_OVERFLOW) + ':' + crypto.createHash('md5').update(cacheKey).digest('hex');
    }
    return cacheKey;
};
const getIncludedHeadersAndCookies = (req, includeHeaders, includeCookies) => {
    const parseCookies = (cookieHeader = '') => {
        const decodeURIComponentSafe = (s) => {
            try {
                return decodeURIComponent(s);
            }
            catch {
                return s;
            }
        };
        const out = Object.create(null);
        if (!cookieHeader)
            return out;
        cookieHeader.split(';').forEach((part) => {
            const [rawK, ...rest] = part.split('=');
            if (!rawK)
                return;
            const k = rawK.trim();
            const v = rest.join('=').trim();
            out[k] = decodeURIComponentSafe(v);
        });
        return out;
    };
    // ---- headers (case-insensitive) ----
    const rawHeaders = req.headers.asObject || {};
    // normalize header names to lowercase for comparison
    const headersLower = Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v]));
    const headerEntries = [];
    (includeHeaders === 'ALL' ? Object.keys(headersLower) : includeHeaders)
        .map((h) => h.toLowerCase())
        .forEach((name) => {
        const v = headersLower[name];
        if (v === undefined)
            return;
        // normalize to array; if an array, flatten; if a string with commas, keep parts separately
        const arr = (Array.isArray(v) ? v : [v])
            .flatMap((x) => String(x).split(',')) // typical multi-value header form
            .map((s) => s.trim())
            .filter(Boolean)
            .sort();
        if (arr.length)
            headerEntries.push([name, arr]);
    });
    // ---- cookies ----
    // Prefer parsed cookies if middleware is present; otherwise parse Cookie header
    const cookieBag = (req.cookies && typeof req.cookies === 'object' && req.cookies) || parseCookies(headersLower.cookie);
    const cookieEntries = [];
    (includeCookies === 'ALL' ? Object.keys(cookieBag) : includeCookies).forEach((name) => {
        const v = cookieBag?.[name];
        if (v === undefined)
            return;
        const arr = Array.isArray(v) ? v.map(String) : [String(v)];
        arr.sort();
        cookieEntries.push([name, arr]);
    });
    return [headerEntries, cookieEntries];
};
const getIncludedQueryParams = (url, includeQuery) => {
    // ---- query params ----
    const queryEntries = [];
    const getAllQueryVals = (key) => url.searchParams.getAll(key).map(String);
    const keys = includeQuery === 'ALL' ? Array.from(new Set(Array.from(url.searchParams.keys()))) : includeQuery;
    keys.forEach((key) => {
        const vals = getAllQueryVals(key).sort();
        if (vals.length)
            queryEntries.push([key, vals]);
    });
    return queryEntries;
};
export const buildPageCacheKey = (req) => {
    const includeHeaders = CACHE_CONFIG.defaultCacheKey?.includeHeaders ?? [];
    const includeCookies = CACHE_CONFIG.defaultCacheKey?.includeCookies ?? [];
    const includeQuery = CACHE_CONFIG.defaultCacheKey?.includeQueryParams ?? [];
    // ---- path + URL parsing ----
    const rawUrl = req.url;
    // URL() needs an origin; dummy one is fine
    const url = new URL(rawUrl, 'http://_');
    const path = url.pathname;
    const [headerEntries, cookieEntries] = getIncludedHeadersAndCookies(req, includeHeaders, includeCookies);
    const queryEntries = getIncludedQueryParams(url, includeQuery);
    return assembleCacheKey(path, headerEntries, queryEntries, cookieEntries);
};
export const buildAPICacheKey = (req) => {
    const includeHeaders = CACHE_CONFIG.apiCacheKey?.includeHeaders ?? [];
    const includeCookies = CACHE_CONFIG.apiCacheKey?.includeCookies ?? [];
    const includeQuery = CACHE_CONFIG.apiCacheKey?.includeQueryParams ?? [];
    // ---- URL + path ----
    const rawUrl = req.url;
    const url = new URL(rawUrl, 'http://_'); // dummy origin for relative URLs
    const path = url.pathname;
    const [headerEntries, cookieEntries] = getIncludedHeadersAndCookies(req, includeHeaders, includeCookies);
    const queryEntries = getIncludedQueryParams(url, includeQuery);
    return assembleCacheKey(path, headerEntries, queryEntries, cookieEntries);
};

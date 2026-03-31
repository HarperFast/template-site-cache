import { CONDITION_OPERATOR, MATCH_TYPE, SPECIAL_TTL } from '../resources/ttlRules.js';
import { headerGet } from './headers.js';
import { CACHE_CONFIG } from '../constants/index.js';
import type { TtlRules, CacheContent } from '../types/graphql.js';
import { OriginErrorResponse } from './originClient.js';
import type { TTLRuleMatchConditions, TTLRuleIndexEntry, TTLRulesIndex, TTLRuleMatchResult } from '../types/index.js';
import type { IncomingMessage } from 'http';

/**
 * Fetches a cache entry from a Harper table, handling origin errors and soft invalidation.
 * On an OriginErrorResponse, records analytics and returns a passthrough Response instead of throwing.
 * On invalidation, evicts the stale entry and re-fetches so the source is called again.
 */
export const fetchCacheEntry = async (
	table: any,
	cacheKey: string,
	cacheInvalidations: Record<string, number>,
	invalidationType: 'page' | 'api',
	startTime: number,
	analyticsLabel: string
): Promise<CacheContent | Response> => {
	const getEntry = async (): Promise<CacheContent | Response> => {
		try {
			return await table.get(cacheKey);
		} catch (err) {
			if (err instanceof OriginErrorResponse) {
				server.recordAnalytics(performance.now() - startTime, 'http-no-cache', analyticsLabel);
				return new Response(err.body, { status: err.status, statusText: err.statusText, headers: err.headers });
			}
			throw err;
		}
	};

	let entry = await getEntry();

	if (
		!(entry instanceof Response) &&
		isInvalidated(invalidationType, cacheInvalidations, entry.refreshedAt!, entry.groupCode)
	) {
		await table.delete(cacheKey);
		entry = await getEntry();
	}

	return entry;
};

export const buildCacheResponse = async (
	entry: CacheContent,
	request: any,
	cacheKey: string,
	cacheStatus: 'hit' | 'miss'
): Promise<Response> => {
	let body: Uint8Array | null;
	try {
		body = entry.data ? await entry.data.bytes() : null;
	} catch (err) {
		logger.error('Error reading cache entry blob', cacheKey, err);
		body = null;
	}
	return new Response(body, {
		status: 200,
		headers: {
			'x-harper': 'true',
			...JSON.parse(entry.headers ?? '{}'),
			'x-harper-cache': cacheStatus,
			...(headerGet(request.headers, 'x-harper-cache-debug')
				? cacheGetObservabilityHeaders(request, cacheKey, entry)
				: {}),
		},
	});
};

// ---------------------------
// --------- helpers ---------
// ---------------------------

/**
 * Extracts and processes cache tags from the provided headers.
 *
 * This function retrieves the value of the 'origin-cache-tag' or 'Origin-Cache-Tag'
 * header
 *
 * @param {Headers} headers - The Headers object containing HTTP headers.
 * @returns {string} cache tags.
 */
export const headerToCacheTags = (headers: Headers) =>
	headers.get(CACHE_CONFIG.cacheTagsHeader) || headers.get(CACHE_CONFIG.cacheTagsHeader?.toLowerCase()) || '';

/**
 * Determines if record is invalidated based on global invalidation timestamps
 *
 * @param {string} type 'api' | 'page'
 * @param {string?} groupCode
 * @param {number} refreshedAt
 * @param {object} invalidationMap map of invalidation timestamps
 */
export const isInvalidated = (
	type: 'api' | 'page',
	invalidationMap: Record<string, number>,
	refreshedAt: number,
	groupCode?: string | null
): boolean => {
	const isGroupInvalidated = groupCode && invalidationMap[groupCode] && refreshedAt < invalidationMap[groupCode];
	const isTypeInvalidated = invalidationMap[type] && refreshedAt < invalidationMap[type];
	return !!isGroupInvalidated || !!isTypeInvalidated;
};

/**
 * Parses a duration string into seconds or special modes.
 *
 * @param {string} ttl String i.e. 30m, 1h, 6h, 1d, 1m, 1y, origin_expires, never
 * @returns {object} { mode: 'ttl'|'origin_expires'|'never', seconds: number}
 */
const parseDuration = (ttl: string): { mode: SPECIAL_TTL | 'ttl'; seconds: number } => {
	const s = String(ttl || '')
		.trim()
		.toLowerCase();
	if (s === SPECIAL_TTL.NEVER) return { mode: SPECIAL_TTL.NEVER, seconds: 0 };
	if (s === SPECIAL_TTL.ORIGIN) return { mode: SPECIAL_TTL.ORIGIN, seconds: 0 };
	const m = /^(\d+)([smhdy])$/.exec(s);
	if (!m) throw new Error('Bad ttl: ' + ttl);
	const n = Number(m[1]);
	const unit: string = m[2];
	const multiplicationFactor = {
		s: 1,
		m: 60,
		h: 3600,
		d: 86400,
		y: 31536000,
	};
	const secs = n * multiplicationFactor[unit as keyof typeof multiplicationFactor];
	return { mode: 'ttl', seconds: secs };
};

/**
 * Extract a literal path prefix from a regex *string*,
 * if it starts with a literal path segment.
 *
 * Examples:
 *   '^/ugp-api/catalog/v\\d+/category/.*$' -> '/ugp-api/catalog'
 *   '^.+/wishlist/.+$'                     -> null   (does not start with a literal)
 *   '(/intl/en|/ca/en)'                    -> null   (front alternation)
 *   '^/.*?/foo'                            -> null   (wildcard in first segment)
 *
 * @param {string} regexStr
 * @returns {string|null}
 */
const fixedPrefixFromRegexStr = (regexStr: string): string | null => {
	let s = String(regexStr).trim();

	// Strip /pattern/flags form if present
	const m = /^\/([\s\S]+)\/[gimsuy]*$/.exec(s);
	if (m) s = m[1];

	// Drop anchors
	if (s.startsWith('^')) s = s.slice(1);
	if (s.endsWith('$')) s = s.slice(0, -1);

	// Normalize escaped slashes
	s = s.replace(/\\\//g, '/');

	// Must start with a literal slash
	if (!s.startsWith('/')) return null;

	const METACHAR = /[.*+?^${}()|[\]\\]/; // any of these means "non-literal"

	const segments = [];
	let i = 1; // start after the leading '/'
	let seg = '';

	// Scan from the start; stop at the first metachar.
	while (i < s.length) {
		const ch = s[i];

		if (ch === '/') {
			// segment boundary: commit current literal segment (if any) and continue
			if (seg.length > 0) segments.push(seg);
			seg = '';
			i++;
			continue;
		}

		// Any regex metachar (including backslash, '(', '[', etc) => stop here
		if (METACHAR.test(ch)) break;

		// literal char
		seg += ch;
		i++;
	}

	// If we never accumulated a first literal segment, the pattern didn't start literal.
	if (segments.length === 0 && seg.length === 0) return null;

	// If the very first segment is empty (e.g., "/(" or "/."), it's not literal-start.
	if (segments.length === 0 && seg.length > 0) {
		// We have a partial first segment before a metachar (e.g., "/ugp-api(").
		// Accept the literal part as the first segment.
		segments.push(seg);
	}

	// After hitting a metachar, we don't include further segments.
	// Return the joined literal run we captured from the start.
	return segments.length ? '/' + segments.join('/') : null;
};

/**
 * Computes and returns an integer specificity score for a given regex string.
 * Higher scores indicate more specific patterns. (Rules will be assessed in order
 * of descending specificity.)
 *
 * @param {string} regexStr
 * @param {boolean} hasConds
 * @returns {number}
 */
const specificityScore = (regexStr: string, hasConds: boolean): number => {
	const wild = (regexStr.match(/[*?]/g) || []).length;
	const literals = regexStr.length - wild;
	const segs = (regexStr.match(/\//g) || []).length;
	return literals + segs * 2 + (hasConds ? 10 : 0);
};

/**
 * Normalize a URL pathname
 *
 * - Decodes URI-escaped characters (best effort; silently ignores decode errors).
 * - Ensures the path starts with a leading "/" (prefixes one if missing).
 * - Strips a trailing "/" except for the root path ("/").
 * - Defaults empty/undefined input to "/".
 *
 * Note: This operates on the pathname only (no query string or hash).
 *
 * @param {string} [pathname] - A raw or partially-encoded pathname (e.g., "/api/v1/", "api/v1", "/api/%E2%9C%93/").
 * @returns {string} A normalized pathname (e.g., "/api/v1", "/").
 */
const normalizePath = (pathname: string): string => {
	try {
		pathname = decodeURI(pathname || '/');
	} catch {}
	if (!pathname.startsWith('/')) pathname = '/' + pathname;
	if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
	const pathWithoutQS = new URL(pathname, 'http://_').pathname;
	if (pathWithoutQS.length > 1 && pathWithoutQS.endsWith('/')) {
		return pathWithoutQS.slice(0, -1);
	}
	return pathWithoutQS;
};

// --------------------------------------------------------
// --------- condition normalization & evaluation ---------
// --------------------------------------------------------

/**
 * Normalize a DB rule's conditional match into a structured object.
 *
 *  * Uses fields on the rule:
 *   - additionalMatchType:      "header" | "query" (case-insensitive)
 *   - additionalMatchOperator:  "equals" | "contains" | "not_equals" | "not_contains" | "exists" | "not_exists"
 *   - additionalMatchKey:       (optional) key name to inspect (e.g., "apiInstance", "catNav")
 *   - additionalMatchValue:     string | string[] (values to compare against; not used for exists/not_exists)
 *
 * Behavior:
 *   - Returns array of `{ type, op, key, values }` where:
 *       - `type`  → "header" | "query"
 *       - `op`    → operator as lower-case string
 *       - `key`   → required for all operators; for exists/not_exists only the key is used
 *       - `values`→ array of strings for value-based operators; `undefined` for exists/not_exists
 *   - If the operator requires a key and/or values and they’re missing, returns `undefined`
 *     so the caller can treat the rule as non-applicable.
 *
 * @param {object} rule - A TTLRules-like row with additionalMatch* fields.
 * @returns {{type:string, op:string, key?:string, values?:string[]}[]}
 *   Array of normalized conditions
 */
const normalizeConds = (rule: TtlRules): TTLRuleMatchConditions[] => {
	const conds: TTLRuleMatchConditions[] = [];

	(rule.additionalMatchCriteria ?? []).forEach((criterion) => {
		const type = (criterion!.additionalMatchType || '').toLowerCase(); // 'header' | 'query'
		const op = (criterion!.additionalMatchOperator || '').toLowerCase(); // equals, contains, not_equals, not_contains, exists, not_exists
		const keyRaw = criterion!.additionalMatchKey;
		const valRaw = criterion!.additionalMatchValue;

		if (!type || !op) return undefined;

		// Key normalization
		const key = keyRaw != null ? String(keyRaw) : undefined;

		// Values normalization (string | string[] -> string[])
		let values;
		if (valRaw == null) {
			values = undefined;
		} else if (Array.isArray(valRaw)) {
			values = valRaw.map((v) => String(v));
		} else {
			values = [String(valRaw)];
		}

		// Requirements by operator
		const needsKey = true; // all operators require a key in this schema
		const needsValues =
			op === CONDITION_OPERATOR.EQUALS ||
			op === CONDITION_OPERATOR.CONTAINS ||
			op === CONDITION_OPERATOR.NOT_EQUALS ||
			op === CONDITION_OPERATOR.NOT_CONTAINS;

		if (needsKey && !key) return undefined;
		if (!needsValues) {
			// exists / not_exists
			conds.push({ type, op, key, values: undefined });
			return;
		}

		// value-based operators
		if (!values || values.length === 0) return;

		conds.push({ type, op, key, values });
	});

	return conds;
};

/**
 * Evaluate a normalized match condition against a Fetch-like request.
 *
 * Supports two condition types:
 *  - "query": compares values from the request's URL query string (all values for the given key).
 *  - "header": compares the specified request header value (case-insensitive key lookup).
 *
 * The comparison logic is delegated to `applyOperator`, which receives:
 *  - the operator (`cond.op`: "equals" | "contains" | "not_equals" | "not_contains" | "exists" | "not_exists"),
 *  - observed value from the request,
 *  - an optional array of expected values (`cond.values`),
 *  - and an optional flag for header comparisons.
 *
 * If `cond` is falsy or the type is unrecognized, the function returns `true` (no constraint).
 *
 * @param {{type:string, op:string, key:string, values?:string[]}|undefined} cond
 *        Normalized condition object to evaluate.
 * @param {{ url:string, headers:Headers }} req
 *        Request-like object with `url` and `headers`.
 * @returns {boolean} `true` if the request satisfies the condition (or no condition), otherwise `false`.
 */
const evalCond = (cond: TTLRuleMatchConditions, req: IncomingMessage): boolean => {
	if (!cond) return true;
	const q = new URLSearchParams(req.url!.split('?')[1]);

	if (cond.type === MATCH_TYPE.QUERY) {
		const queryVal = q.get(cond.key!);
		return applyOperator(cond.op, queryVal, cond.values);
	}
	if (cond.type === MATCH_TYPE.HEADER) {
		const headerVal = headerGet(req.headers, cond.key as string);
		return applyOperator(cond.op, headerVal, cond.values);
	}
	return true;
};

/**
 * Apply a comparison operator to a set of observed values.
 *
 * Supported operators (from CONDITION_OPERATOR):
 *  - EXISTS:        true if at least one observed value is present.
 *  - NOT_EXISTS:    true if no observed values are present.
 *  - EQUALS:        true if any observed value exactly matches any expected value.
 *  - NOT_EQUALS:    true if none of the observed values exactly match any expected value
 *                   (also true when no observed values are present or when no expected values are provided).
 *  - CONTAINS:      true if any observed value contains (case-insensitive) any expected value as a substring.
 *  - NOT_CONTAINS:  true if none of the observed values contain (case-insensitive) any expected value as a substring
 *                   (also true when no observed values are present or when no expected values are provided).
 *  - default:       returns true for unrecognized operators (no constraint).
 *
 * @param {string} op
 *   Operator identifier (e.g., CONDITION_OPERATOR.EQUALS).
 * @param {string|undefined} received
 *   Array of observed values from the request (query/header). May be empty.
 * @param {Array<string>|undefined} searchList
 *   Array of expected values. Required by value-based operators (EQUALS/NOT_EQUALS/CONTAINS/NOT_CONTAINS);
 *   ignored for EXISTS/NOT_EXISTS.
 * @returns {boolean}
 *   Whether the observed values satisfy the operator relative to the expected values.
 */
const applyOperator = (op: string, received: string | null, searchList?: string | string[]): boolean => {
	logger.info(`Applying operator ${op} on received=${received} against searchList=${searchList}`);

	const gotExists = received && received.length > 0;

	switch (op) {
		case CONDITION_OPERATOR.EXISTS:
			return !!gotExists;
		case CONDITION_OPERATOR.NOT_EXISTS:
			return !gotExists;

		case CONDITION_OPERATOR.EQUALS: {
			if (!gotExists) return false;
			if (!searchList || searchList.length === 0) return false;
			// any exact match
			return received === searchList[0];
		}

		case CONDITION_OPERATOR.NOT_EQUALS: {
			if (!searchList || searchList.length === 0) return true; // nothing to compare => allow
			if (!gotExists) return true; // no value present => not equal
			return received !== searchList[0];
		}

		case CONDITION_OPERATOR.CONTAINS: {
			if (!gotExists) return false;
			if (!searchList || searchList.length === 0) return false;
			return searchList.some((s) => received.includes(s));
		}

		case CONDITION_OPERATOR.NOT_CONTAINS: {
			if (!searchList || searchList.length === 0) return true;
			if (!gotExists) return true;
			return !searchList.some((s) => received.includes(s));
		}

		default:
			return true;
	}
};

/* ---------------------------------------------- */
// --------- build index (from DB rows) ---------
/* ---------------------------------------------- */

/**
 * Builds an in-memory index from an array of TTLRules for efficient matching of incoming requests
 *
 * @param {object} ttlRulesRows - A TTLRules-like row with additionalMatch* fields.
 * @returns {object} An index object containing bucketed rules
 */
const buildRuleIndex = (ttlRulesRows: TtlRules[]): TTLRulesIndex => {
	const rules: TTLRuleIndexEntry[] = [];

	for (const row of ttlRulesRows || []) {
		const ttlParsed = parseDuration(row.ttl);
		const conds = normalizeConds(row);
		const patterns = (row.pathPatterns || []).map((s) => String(s).trim()).filter(Boolean);

		for (const pat of patterns) {
			rules.push({
				id: (row.id as string) || '',
				name: row.description || (row.id as string) || 'rule',
				patternText: pat,
				regex: new RegExp(pat),
				prefix: fixedPrefixFromRegexStr(pat),
				ttl: ttlParsed,
				conds,
				specificity: specificityScore(pat, !!conds.length),
				groupCode: row.groupCode || null,
			});
		}
	}

	const buckets = new Map<string, TTLRuleIndexEntry[]>();
	const general: TTLRuleIndexEntry[] = [];
	for (const r of rules) {
		const key = r.prefix || '';
		if (!key) general.push(r);
		else {
			if (!buckets.has(key)) buckets.set(key, []);
			buckets.get(key)?.push(r);
		}
	}
	for (const arr of buckets.values()) arr.sort((a, b) => b.specificity - a.specificity);
	general.sort((a, b) => b.specificity - a.specificity);
	const prefixes = Array.from(buckets.keys()).sort((a, b) => b.length - a.length);

	return { buckets, general, prefixes, rawCount: rules.length };
};

// --------- memoization for rapid lookups on hot paths ---------
const _memo = new Map();
const MEMO_MAX = 5000;

const memoGet = (k: string): TTLRuleMatchResult => _memo.get(k);
const memoSet = (k: string, v: TTLRuleMatchResult) => {
	_memo.set(k, v);
	if (_memo.size > MEMO_MAX) _memo.delete(_memo.keys().next().value);
};
const clearMemo = () => _memo.clear();

// --------- hot-reloadable rules index ---------
let _RULE_INDEX = buildRuleIndex([]);

const swapRules = (rows: TtlRules[]) => {
	_RULE_INDEX = buildRuleIndex(rows);
	logger.debug('Rebuilt rules index');
	logger.debug(_RULE_INDEX);
	_memo.clear(); // ensure new rules take effect immediately
};

/* -------------------------------------------- */
// --------- classifier (per request) ---------
/* -------------------------------------------- */

/**
 * Classify a request against the active TTL rules index and memoize the result.
 *
 * Flow:
 *  - Normalizes the request pathname.
 *  - Attempts a memoized lookup by the provided `cacheKey`.
 *  - If not memoized, selects a candidate bucket by longest path prefix,
 *    appends general rules, then scans in specificity order:
 *      - applies the rule's condition (via `evalCond`)
 *      - tests the rule's compiled regex against the pathname
 *    and picks the first matching rule.
 *  - Builds a result object describing the applied policy and metadata,
 *    stores it in the memo under `cacheKey`, and returns it with a memo flag.
 *
 * Returns:
 *  - On memo hit: `{ ...cachedResult, memo: 'hit' }`
 *  - On fresh evaluation: `{ memo: 'miss', ...result }`
 *    where `result` (when a rule matched) includes:
 *      - `policy`        : "ttl" | "origin_expires" | "never"
 *      - `ttlSeconds`    : number (0 when not applicable)
 *      - `ruleName`      : string
 *      - `ruleId`        : string|undefined
 *      - `matchedPattern`: string (the glob pattern that matched)
 *      - `bucketPrefix`  : string (the prefix bucket used)
 *
 * Notes:
 *  - Uses the global `_RULE_INDEX` (with `prefixes`, `buckets`, `general`) and
 *    the memo helpers `memoGet` / `memoSet`.
 *  - Assumes candidate rules are pre-sorted by specificity (most specific first).
 */
export const classifyRequest = (
	req: IncomingMessage,
	cacheKey: string
): (TTLRuleMatchResult & { memo: 'hit' | 'miss' }) | null => {
	const pathname = normalizePath(req.url!);
	logger.info(`Checking TTL rule for ${pathname}`);

	const cached = memoGet(cacheKey);
	if (cached) return { ...cached, memo: 'hit' };

	const idx = _RULE_INDEX;
	let bucketPrefix = '';
	let bucket = null;

	logger.info(`Checking ${idx.prefixes.length} prefixes`);

	for (const p of idx.prefixes) {
		logger.debug(`Checking prefix ${p}`);
		if (pathname.startsWith(p)) {
			bucketPrefix = p;
			bucket = idx.buckets.get(p);
			break;
		}
	}

	const candidates = [];
	if (bucket) candidates.push(...bucket);
	candidates.push(...idx.general);
	logger.info(`Checking ${candidates.length} candidates`);

	let match = null;
	for (const r of candidates) {
		logger.debug('Checking candidate: ', r);
		logger.debug('Additional conditions: ', r.conds);
		if (r.conds.length && r.conds.some((cond) => !evalCond(cond, req))) continue;
		if (!r.regex.test(pathname)) continue;
		match = r;
		break; // specificity already sorted
	}

	const result = match
		? {
				policy: match.ttl.mode, // 'ttl' | 'origin_expires' | 'never'
				ttlSeconds: match.ttl.seconds || 0,
				ruleName: match.name,
				ruleId: match.id,
				matchedPattern: match.patternText,
				bucketPrefix,
				groupCode: match.groupCode,
			}
		: null;

	if (!result) {
		return null;
	}

	// Note: this can be improved but for now skip memoization if there's additional conditions
	if (result && !match?.conds.length) {
		memoSet(cacheKey, result as unknown as TTLRuleMatchResult);
	}
	return { memo: 'miss', ...(result as unknown as TTLRuleMatchResult) };
};

/* -------------------------------------------------------------- */
/* --------------------- SETTINGS HYDRATION --------------------- */
/* -------------------------------------------------------------- */
const TTLRulesTable = databases.CacheManagement.TTLRules;

const applySettings = async () => {
	const rulesIter = await TTLRulesTable.search();
	const rules = (await Array.fromAsync(rulesIter)) as unknown as TtlRules[];
	swapRules(rules);
	clearMemo();
};

const initializeTTLRulesSubscription = async () => {
	try {
		await applySettings();
		const subscription = await TTLRulesTable.subscribe({ omitCurrent: true });

		subscription.on('data', async () => {
			try {
				await applySettings();
			} catch (error) {
				logger.error('Failed to apply TTL settings after table update', error);
			}
		});

		subscription.on('error', (error: unknown) => {
			logger.error('TTLRules subscription error', error);
		});
	} catch (error) {
		logger.error('Failed to initialize TTLRules subscription', error);
	}
};

void initializeTTLRulesSubscription();

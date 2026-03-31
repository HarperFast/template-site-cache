import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { errors, Pool } from 'undici';
import { buildUpstreamHeaders } from './headers.js';
import { resolveOriginAuthHeader } from '../constants/index.js';

const DEFAULT_ORIGIN_MAX_CONNECTIONS = 80;
const DEFAULT_CLIENT_TTL_MS = 300_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_TIMEOUT_MS = 60_000;

const STATS_INTERVAL_MS = 30_000;
const QUEUE_WARN_THRESHOLD = 5; // requests waiting for a free socket
const UTILIZATION_WARN_THRESHOLD = 0.9; // fraction of connections in use

const poolsByOrigin = new Map();

setInterval(() => {
	for (const [origin, pool] of poolsByOrigin) {
		const { connected, free, pending, queued, running } = pool.stats;
		const utilization = connected > 0 ? running / DEFAULT_ORIGIN_MAX_CONNECTIONS : 0;

		if (queued > QUEUE_WARN_THRESHOLD || utilization >= UTILIZATION_WARN_THRESHOLD) {
			logger.warn(
				`[ORIGIN POOL] unhealthy pool for ${origin} — queued: ${queued}, pending: ${pending}, running: ${running}, free: ${free}, connected: ${connected}, utilization: ${(utilization * 100).toFixed(1)}%`
			);
		} else {
			logger.info(
				`[ORIGIN POOL] pool stats for ${origin} — queued: ${queued}, pending: ${pending}, running: ${running}, free: ${free}, connected: ${connected}, utilization: ${(utilization * 100).toFixed(1)}%`
			);
		}
	}
}, STATS_INTERVAL_MS).unref();

const parseBool = (value: string | undefined): boolean =>
	['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
const randomInt = (min: number, max: number) => {
	if (max <= min) return min;
	return Math.floor(Math.random() * (max - min + 1)) + min;
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const resolveEnvInt = (name: string, defaultValue: number): number =>
	process.env[name] ? parseInt(process.env[name], 10) : defaultValue;

/**
 *
 * Load testing mode: when enabled, `fetchFromOrigin` will return mock responses with random delays and body sizes,
 *
 */
const LOAD_TEST_MODE = parseBool(process.env.HDB_LOAD_TEST_MODE);
const LOAD_TEST_MIN_DELAY_MS = 30;
const LOAD_TEST_MAX_DELAY_MS = 250;
const LOAD_TEST_MIN_BYTES = 25_000;
const LOAD_TEST_MAX_BYTES = 220_000;
const LOAD_TEST_CHUNK_MIN_BYTES = 4_096;
const LOAD_TEST_CHUNK_MAX_BYTES = 16_384;
const LOAD_TEST_STATUS = 200;

const randomByteStream = (totalBytes: number): ReadableStream<Uint8Array> => {
	let bytesSent = 0;

	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (bytesSent >= totalBytes) {
				controller.close();
				return;
			}

			const remaining = totalBytes - bytesSent;
			const chunkSize = Math.min(remaining, randomInt(LOAD_TEST_CHUNK_MIN_BYTES, LOAD_TEST_CHUNK_MAX_BYTES));
			const chunk = randomBytes(chunkSize);
			bytesSent += chunkSize;
			controller.enqueue(chunk);
		},
	});
};

const mockFetchFromOrigin = async (_url: URL, init: RequestInit = {}) => {
	const method = String(init.method || 'GET').toUpperCase();

	const delayMs = randomInt(LOAD_TEST_MIN_DELAY_MS, LOAD_TEST_MAX_DELAY_MS);
	if (delayMs > 0) {
		await wait(delayMs);
	}

	const totalBytes = method === 'HEAD' ? 0 : randomInt(LOAD_TEST_MIN_BYTES, LOAD_TEST_MAX_BYTES);

	const headers = new Headers({
		'content-type': 'text/html; charset=utf-8',
		'x-origin-cache-tags': 'tag:loadtest',
		'x-load-test-origin': 'true',
		'cache-control': 'public, max-age=120',
	});

	if (totalBytes > 0) {
		headers.set('content-length', String(totalBytes));
	}

	const body = method === 'HEAD' ? null : randomByteStream(totalBytes);

	// TODO: make this return a readable stream to better simulate real origin responses, and to test streaming behavior in the cache and downstream.
	return new Response(body, {
		status: LOAD_TEST_STATUS,
		statusText: 'Load Test Mock Origin Response',
		headers,
	});
};
/**
 * * ================================================================================================
 */

const getPool = (origin: string): Pool => {
	let pool = poolsByOrigin.get(origin);
	if (!pool) {
		pool = new Pool(origin, {
			connections: resolveEnvInt('MAX_CONNECTIONS', DEFAULT_ORIGIN_MAX_CONNECTIONS),
			keepAliveTimeout: resolveEnvInt('CLIENT_TTL_MS', DEFAULT_CLIENT_TTL_MS),
			keepAliveMaxTimeout: resolveEnvInt('CLIENT_TTL_MS', DEFAULT_CLIENT_TTL_MS),
			headersTimeout: resolveEnvInt('HEADERS_TIMEOUT_MS', DEFAULT_HEADERS_TIMEOUT_MS),
			bodyTimeout: resolveEnvInt('BODY_TIMEOUT_MS', DEFAULT_BODY_TIMEOUT_MS),
			connect: { timeout: resolveEnvInt('CONNECT_TIMEOUT_MS', DEFAULT_CONNECT_TIMEOUT_MS) },
		});
		poolsByOrigin.set(origin, pool);
	}
	return pool;
};

const TIMEOUT_504 = {
	status: 504,
	statusText: 'Gateway Timeout',
	headers: {},
	body: null as unknown as ReadableStream<Uint8Array>,
	ok: false,
};

export class OriginErrorResponse extends Error {
	constructor(
		public readonly status: number,
		public readonly statusText: string,
		public readonly headers: Record<string, string>,
		public readonly body: ReadableStream<Uint8Array> | null
	) {
		super(`Origin responded with ${status}`);
	}
}

export const buildOriginUrl = (
	request: any,
	origin: string,
	pathReplacement?: { search: string; replace: string }
): URL => {
	const path = request.url as string;
	if (pathReplacement) {
		return new URL(path.replace(pathReplacement.search, pathReplacement.replace), origin);
	}
	return new URL(path, origin);
};

export const buildUpstreamRequestHeaders = (
	request: any,
	target: 'defaultOrigin' | 'apiOrigin'
): Record<string, string> => {
	const headers = buildUpstreamHeaders(request.headers);
	const originAuthHeader = resolveOriginAuthHeader(target);
	if (originAuthHeader) {
		headers[originAuthHeader.headerName] = originAuthHeader.token;
	}
	return headers;
};

export const fetchFromOrigin = async (url: URL, init: Record<string, any> = {}) => {
	if (LOAD_TEST_MODE) {
		return mockFetchFromOrigin(url, init as RequestInit);
	}

	const pool = getPool(url.origin);
	let result: Awaited<ReturnType<Pool['request']>>;
	try {
		result = await pool.request({
			path: url.pathname + url.search,
			method: init.method ?? 'GET',
			headers: init.headers,
			body: init.body ?? null,
		});
	} catch (err) {
		if (
			err instanceof errors.HeadersTimeoutError ||
			err instanceof errors.BodyTimeoutError ||
			err instanceof errors.ConnectTimeoutError
		) {
			logger.warn(`[ORIGIN TIMEOUT] ${err.constructor.name}: ${url.pathname + url.search}`);
			return TIMEOUT_504;
		}
		throw err;
	}

	const stats = pool.stats;
	logger.info('Origin pool stats', {
		origin: url.origin,
		connected: stats.connected,
		free: stats.free,
		pending: stats.pending,
		queued: stats.queued,
		running: stats.running,
		size: stats.size,
	});

	if (result.statusCode >= 500) {
		logger.warn(
			`[ORIGIN ERROR] status: ${result.statusCode}, url: ${url.pathname + url.search}, method: ${init.method ?? 'GET'}`
		);
	}

	return {
		status: result.statusCode,
		statusText: '',
		headers: result.headers,
		body: Readable.toWeb(result.body) as ReadableStream<Uint8Array>,
		ok: result.statusCode >= 200 && result.statusCode < 300,
	};
};

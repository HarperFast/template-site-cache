import { randomBytes } from 'node:crypto';
import { Pool, fetch as undiciFetch } from 'undici';

const DEFAULT_ORIGIN_MAX_CONNECTIONS = 80;
const DEFAULT_CLIENT_TTL_MS = 300_000;

const poolsByOrigin = new Map();

const parseBool = (value: string | undefined): boolean =>
	['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
const randomInt = (min: number, max: number) => {
	if (max <= min) return min;
	return Math.floor(Math.random() * (max - min + 1)) + min;
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const resolveEnvInt = (name: string, defaultValue: number): number => process.env[name] ? parseInt(process.env[name]!, 10) : defaultValue;

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

	return new Response(body, {
		status: LOAD_TEST_STATUS,
		statusText: 'Load Test Mock Origin Response',
		headers,
	});
};

const getPool = (origin: string): Pool => {
	let pool = poolsByOrigin.get(origin);
	if (!pool) {
		pool = new Pool(origin, {
			connections: resolveEnvInt('MAX_CONNECTIONS', DEFAULT_ORIGIN_MAX_CONNECTIONS),
			keepAliveTimeout: resolveEnvInt('CLIENT_TTL_MS', DEFAULT_CLIENT_TTL_MS),
			keepAliveMaxTimeout: resolveEnvInt('CLIENT_TTL_MS', DEFAULT_CLIENT_TTL_MS),
		});
		poolsByOrigin.set(origin, pool);
	}
	return pool;
};

export const fetchFromOrigin = (url: URL, init = {}) => {
	if (LOAD_TEST_MODE) {
		return mockFetchFromOrigin(url, init as RequestInit);
	}

	const pool = getPool(url.origin);
	return undiciFetch(url, { ...init, dispatcher: pool });
};

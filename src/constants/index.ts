import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const HANDLER_TIMEOUT_MS = process.env.REQUEST_TIMEOUT_MS ? parseInt(process.env.REQUEST_TIMEOUT_MS, 10) : 30_000;
export const KEY_OVERFLOW = 1000; // max key size before hashing
export const NO_BODY_RESPONSES = new Set([204, 304]); // HTTP status codes that must not have a body
export const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const ALLOWED_ROLES_CACHE = ['cache_user', 'cache_admin', 'super_user'];
export const ALLOWED_ROLES_ADMIN = ['cache_admin', 'super_user'];
export const CACHE_INVALIDATION_KEY = 1; // Primary key for cache invalidation record in the database

type OriginTarget = 'defaultOrigin' | 'apiOrigin';

const normalizeEnv = (raw?: string): string => {
	const val = String(raw || '')
		.trim()
		.toLowerCase();
	if (!val) return 'local';
	if (val === 'production') return 'prod';
	if (val === 'staging') return 'stage';
	return val;
};

const env = normalizeEnv(process.env.ENVIRONMENT);
const configPath = resolve(process.cwd(), `cacheConfiguration.${env}.json`);

let cacheConfigData: Record<string, any>;
try {
	cacheConfigData = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch {
	throw new Error(
		`Failed to load cacheConfiguration.${env}.json (resolved to ${configPath}). Set the ENVIRONMENT env var to match a cacheConfiguration.<env>.json file.`
	);
}

export const CACHE_CONFIG: Record<string, any> = cacheConfigData;

const EXTRA_RESERVED_PATHS = process.env.RESERVED_PATHS
	? process.env.RESERVED_PATHS.split(',')
			.map((p) => p.trim())
			.filter(Boolean)
	: [];
export const RESERVED_PATHS = [
	'/status',
	'/prometheus_exporter/metrics',
	'/cache/ttlConfig',
	'/cache/invalidate',
	...EXTRA_RESERVED_PATHS,
];

const getTrimmedString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const getAuthHeaderConfigKey = (target: OriginTarget) =>
	target === 'apiOrigin' ? 'apiOriginAuthHeader' : 'defaultOriginAuthHeader';

const getAuthTokenEnvNames = (target: OriginTarget) =>
	target === 'apiOrigin'
		? ['HDB_API_ORIGIN_AUTH_TOKEN', 'API_ORIGIN_AUTH_TOKEN']
		: ['HDB_DEFAULT_ORIGIN_AUTH_TOKEN', 'DEFAULT_ORIGIN_AUTH_TOKEN'];

export const resolveOriginAuthHeader = (target: OriginTarget): { headerName: string; token: string } | null => {
	const headerConfigKey = getAuthHeaderConfigKey(target);
	const headerName = getTrimmedString(CACHE_CONFIG?.[headerConfigKey]);
	if (!headerName) {
		return null;
	}

	const tokenEnvNames = getAuthTokenEnvNames(target);
	const token = tokenEnvNames.map((name) => getTrimmedString(process.env[name])).find((value) => !!value);

	if (!token) {
		throw new Error(
			`cacheConfiguration.${env}.json sets "${headerConfigKey}" but no token environment variable was provided. Set one of: ${tokenEnvNames.join(', ')}`
		);
	}

	return { headerName, token };
};

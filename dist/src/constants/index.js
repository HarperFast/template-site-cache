import cacheConfiguration from '../../cacheConfiguration.json' with { type: 'json' };
export const RESERVED_PATHS = ['/status', '/prometheus_exporter/metrics', '/cache/ttlConfig', '/cache/invalidate']; // Paths that bypass cache logic
export const KEY_OVERFLOW = 1000; // max key size before hashing
export const NO_BODY_RESPONSES = new Set([204, 304]); // HTTP status codes that must not have a body
export const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const ALLOWED_ROLES = ['cache_user', 'super_user'];
export const CACHE_INVALIDATIONM_KEY = 1; // Primary key for cache invalidation record in the database
export const CACHE_CONFIG = cacheConfiguration;
const normalizeEnvironment = (rawEnv) => {
    const env = String(rawEnv || '')
        .trim()
        .toLowerCase();
    if (!env)
        return undefined;
    if (env === 'prod' || env === 'production')
        return 'prod';
    if (env === 'stage' || env === 'staging')
        return 'stage';
    return env;
};
export const resolveConfiguredOrigin = (target) => {
    const envOverride = target === 'defaultOrigin'
        ? process.env.CACHE_DEFAULT_ORIGIN_OVERRIDE || process.env.HDB_DEFAULT_ORIGIN
        : process.env.CACHE_API_ORIGIN_OVERRIDE || process.env.HDB_API_ORIGIN;
    if (typeof envOverride === 'string' && envOverride) {
        return envOverride;
    }
    const configuredOrigins = CACHE_CONFIG?.[target];
    if (typeof configuredOrigins === 'string' && configuredOrigins) {
        return configuredOrigins;
    }
    if (!configuredOrigins || typeof configuredOrigins !== 'object') {
        throw new Error(`Missing ${target} in cacheConfiguration.json`);
    }
    const environmentKey = normalizeEnvironment(process.env.ENVIRONMENT);
    if (environmentKey && typeof configuredOrigins[environmentKey] === 'string') {
        return configuredOrigins[environmentKey];
    }
    if (typeof configuredOrigins.stage === 'string') {
        return configuredOrigins.stage;
    }
    if (typeof configuredOrigins.prod === 'string') {
        return configuredOrigins.prod;
    }
    const firstOrigin = Object.values(configuredOrigins).find((value) => typeof value === 'string');
    if (typeof firstOrigin === 'string') {
        return firstOrigin;
    }
    throw new Error(`Could not resolve ${target}. Set ENVIRONMENT to a configured key or provide stage/prod values in cacheConfiguration.json`);
};
const getTrimmedString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const getAuthHeaderConfigKey = (target) => target === 'apiOrigin' ? 'apiOriginAuthHeader' : 'defaultOriginAuthHeader';
const getAuthTokenEnvNames = (target) => target === 'apiOrigin'
    ? ['HDB_API_ORIGIN_AUTH_TOKEN', 'API_ORIGIN_AUTH_TOKEN']
    : ['HDB_DEFAULT_ORIGIN_AUTH_TOKEN', 'DEFAULT_ORIGIN_AUTH_TOKEN'];
export const resolveOriginAuthHeader = (target) => {
    const headerConfigKey = getAuthHeaderConfigKey(target);
    const headerName = getTrimmedString(CACHE_CONFIG?.[headerConfigKey]);
    if (!headerName) {
        return null;
    }
    const tokenEnvNames = getAuthTokenEnvNames(target);
    const token = tokenEnvNames.map((name) => getTrimmedString(process.env[name])).find((value) => !!value);
    if (!token) {
        throw new Error(`cacheConfiguration.json sets "${headerConfigKey}" but no token environment variable was provided. Set one of: ${tokenEnvNames.join(', ')}`);
    }
    return { headerName, token };
};

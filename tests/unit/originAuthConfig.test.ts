import assert from 'node:assert/strict';
import { afterEach, before, describe, test } from 'node:test';

import cacheConfiguration from '../../cacheConfiguration.json' with { type: 'json' };
import { resolveOriginAuthHeader } from '../../src/constants/index.ts';

const config = cacheConfiguration as any;
const originalApiOriginAuthHeader = config.apiOriginAuthHeader;
const originalDefaultOriginAuthHeader = config.defaultOriginAuthHeader;

const envKeys = [
	'HDB_API_ORIGIN_AUTH_TOKEN',
	'API_ORIGIN_AUTH_TOKEN',
	'HDB_DEFAULT_ORIGIN_AUTH_TOKEN',
	'DEFAULT_ORIGIN_AUTH_TOKEN',
];

const clearAuthEnv = () => {
	for (const key of envKeys) {
		delete process.env[key];
	}
};

before(() => {
	clearAuthEnv();
});

afterEach(() => {
	config.apiOriginAuthHeader = originalApiOriginAuthHeader;
	config.defaultOriginAuthHeader = originalDefaultOriginAuthHeader;
	clearAuthEnv();
});

describe('origin auth header configuration', () => {
	test('returns null when api auth header is not configured', () => {
		config.apiOriginAuthHeader = '';
		assert.equal(resolveOriginAuthHeader('apiOrigin'), null);
	});

	test('returns null when default auth header is not configured', () => {
		config.defaultOriginAuthHeader = '';
		assert.equal(resolveOriginAuthHeader('defaultOrigin'), null);
	});

	test('throws when api auth header is configured but token env var is missing', () => {
		config.apiOriginAuthHeader = 'Authorization';

		assert.throws(
			() => resolveOriginAuthHeader('apiOrigin'),
			/error.*environment variable|token environment variable|Set one of/i
		);
	});

	test('throws when default auth header is configured but token env var is missing', () => {
		config.defaultOriginAuthHeader = 'X-Origin-Token';

		assert.throws(
			() => resolveOriginAuthHeader('defaultOrigin'),
			/error.*environment variable|token environment variable|Set one of/i
		);
	});

	test('uses HDB_* token env vars when provided', () => {
		config.apiOriginAuthHeader = 'Authorization';
		config.defaultOriginAuthHeader = 'X-Origin-Token';
		process.env.HDB_API_ORIGIN_AUTH_TOKEN = 'api-token-hdb';
		process.env.HDB_DEFAULT_ORIGIN_AUTH_TOKEN = 'default-token-hdb';

		assert.deepEqual(resolveOriginAuthHeader('apiOrigin'), {
			headerName: 'Authorization',
			token: 'api-token-hdb',
		});
		assert.deepEqual(resolveOriginAuthHeader('defaultOrigin'), {
			headerName: 'X-Origin-Token',
			token: 'default-token-hdb',
		});
	});

	test('falls back to non-HDB token env vars', () => {
		config.apiOriginAuthHeader = 'Authorization';
		config.defaultOriginAuthHeader = 'X-Origin-Token';
		process.env.API_ORIGIN_AUTH_TOKEN = 'api-token-fallback';
		process.env.DEFAULT_ORIGIN_AUTH_TOKEN = 'default-token-fallback';

		assert.deepEqual(resolveOriginAuthHeader('apiOrigin'), {
			headerName: 'Authorization',
			token: 'api-token-fallback',
		});
		assert.deepEqual(resolveOriginAuthHeader('defaultOrigin'), {
			headerName: 'X-Origin-Token',
			token: 'default-token-fallback',
		});
	});
});

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { buildAPICacheKey, buildPageCacheKey } from '../../src/util/cacheKeys.ts';
import { CACHE_CONFIG } from '../../src/constants/index.ts';

const config = CACHE_CONFIG;
const originalDefaultCacheKey = structuredClone(config.defaultCacheKey);
const originalApiCacheKey = structuredClone(config.apiCacheKey);

const fakeRequest = (url: string, headers: Record<string, string> = {}) =>
	({
		url,
		headers: { asObject: headers },
	}) as any;

before(() => {
	config.defaultCacheKey = {
		includeHeaders: ['x-ae-optimizely-cache-value'],
		includeQueryParams: ['filter', 'prodId'],
		includeCookies: ['brand'],
	};

	config.apiCacheKey = {
		includeHeaders: ['appVersion'],
		includeQueryParams: 'ALL',
		includeCookies: [],
	};
});

after(() => {
	config.defaultCacheKey = originalDefaultCacheKey;
	config.apiCacheKey = originalApiCacheKey;
});

describe('cache key construction', () => {
	test('Paths are cases insensitive', () => {
		const requestA = fakeRequest('/US/en');
		const cacheKeyA = buildPageCacheKey(requestA);
		const requestB = fakeRequest('/us/en');
		const cacheKeyB = buildPageCacheKey(requestB);

		assert.equal(cacheKeyA, cacheKeyB);
	});

	test('Paths with & without trailing slash produce same key', () => {
		const requestA = fakeRequest('/us/en/');
		const cacheKeyA = buildPageCacheKey(requestA);
		const requestB = fakeRequest('/us/en');
		const cacheKeyB = buildPageCacheKey(requestB);

		assert.equal(cacheKeyA, cacheKeyB);
	});

	describe('pageCache', () => {
		test('Does not include query params not part of include list', () => {
			const request = fakeRequest('/?utm_source=google&foo=bar&1234');
			const cacheKey = buildPageCacheKey(request);

			assert.equal(cacheKey, 'p=/');
		});

		test('Includes query params that are part of include list', () => {
			const request = fakeRequest('/?utm_source=google&filter=foo&prodId=ABC&foo=bar&1234');
			const cacheKey = buildPageCacheKey(request);

			assert.equal(cacheKey, 'p=/|q=filter=foo&prodId=ABC');
		});

		test('Different ordering of same query param produces same cache key', () => {
			const requestA = fakeRequest('/?aeCountry=US&filter=foo&prodId=ABC');
			const cacheKeyA = buildPageCacheKey(requestA);
			const requestB = fakeRequest('/?prodId=ABC&filter=foo&aeCountry=US');
			const cacheKeyB = buildPageCacheKey(requestB);

			assert.equal(cacheKeyA, cacheKeyB);
		});

		test('Does not include headers not part of include list', () => {
			const request = fakeRequest('/', {
				'host': 'example.com',
				'user-agent': 'Mozilla/5.0',
				'x-custom-header': 'customValue',
			});
			const cacheKey = buildPageCacheKey(request);

			assert.equal(cacheKey, 'p=/');
		});

		test('Includes headers that are part of include list', () => {
			const request = fakeRequest('/', {
				'host': 'example.com',
				'user-agent': 'Mozilla/5.0',
				'x-custom-header': 'customValue',
				'x-ae-optimizely-cache-value': 'ABCDE',
			});
			const cacheKey = buildPageCacheKey(request);

			assert.equal(cacheKey, 'p=/|h=x-ae-optimizely-cache-value=ABCDE');
		});

		test('Handles different header casing, normalizing to lowercase', () => {
			const request = fakeRequest('/', {
				'X-AE-Optimizely-Cache-Value': 'ABCDE',
			});
			const cacheKey = buildPageCacheKey(request);

			assert.equal(cacheKey, 'p=/|h=x-ae-optimizely-cache-value=ABCDE');
		});

		test('Does not include cookies not part of include list', () => {
			const request = fakeRequest('/', {
				cookie: 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9; cart=%5B%2271%22%2C%2292%22%5D',
			});
			const cacheKey = buildPageCacheKey(request);

			assert.equal(cacheKey, 'p=/');
		});

		test('Includes cookies that are part of include list', () => {
			const request = fakeRequest('/', {
				cookie: 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9; cart=%5B%2271%22%2C%2292%22%5D; brand=ae',
			});
			const cacheKey = buildPageCacheKey(request);

			assert.equal(cacheKey, 'p=/|c=brand=ae');
		});

		test('Builds correct cache key from multiple parts', () => {
			const request = fakeRequest('/?prodId=ABC&filter=foo&aeCountry=US', {
				'host': 'example.com',
				'user-agent': 'Mozilla/5.0',
				'x-custom-header': 'customValue',
				'x-ae-optimizely-cache-value': 'ABCDE',
				'cookie': 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9; cart=%5B%2271%22%2C%2292%22%5D; brand=ae',
			});
			const cacheKey = buildPageCacheKey(request);

			assert.equal(cacheKey, 'p=/|h=x-ae-optimizely-cache-value=ABCDE|c=brand=ae|q=filter=foo&prodId=ABC');
		});
	});

	describe('apiCache', () => {
		test('Includes all query params in key', () => {
			const request = fakeRequest('/api/?foo=bar&test=1234&zotherParam=5678');
			const cacheKey = buildAPICacheKey(request);

			assert.equal(cacheKey, 'p=/api/|q=foo=bar&test=1234&zotherParam=5678');
		});

		test('Different ordering of same query param produces same cache key', () => {
			const requestA = fakeRequest('/api/?foo=bar&test=1234&zotherParam=5678');
			const cacheKeyA = buildAPICacheKey(requestA);
			const requestB = fakeRequest('/api/?zotherParam=5678&foo=bar&test=1234');
			const cacheKeyB = buildAPICacheKey(requestB);

			assert.equal(cacheKeyA, cacheKeyB);
		});

		test('Does not include headers not part of include list', () => {
			const request = fakeRequest('/api/', {
				'host': 'example.com',
				'user-agent': 'Mozilla/5.0',
				'x-custom-header': 'customValue',
			});
			const cacheKey = buildAPICacheKey(request);

			assert.equal(cacheKey, 'p=/api/');
		});

		test('Includes headers that are part of include list', () => {
			const request = fakeRequest('/api/', {
				'host': 'example.com',
				'user-agent': 'Mozilla/5.0',
				'x-custom-header': 'customValue',
				'appVersion': 'v1',
			});
			const cacheKey = buildAPICacheKey(request);

			assert.equal(cacheKey, 'p=/api/|h=appversion=v1');
		});

		test('Builds correct cache key from multiple parts', () => {
			const request = fakeRequest('/api/?zotherParam=5678&foo=bar&test=1234', {
				'host': 'example.com',
				'user-agent': 'Mozilla/5.0',
				'x-custom-header': 'customValue',
				'appVersion': 'v1',
				'cookie': 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9; cart=%5B%2271%22%2C%2292%22%5D; brand=ae',
			});
			const cacheKey = buildAPICacheKey(request);

			assert.equal(cacheKey, 'p=/api/|h=appversion=v1|q=foo=bar&test=1234&zotherParam=5678');
		});
	});
});

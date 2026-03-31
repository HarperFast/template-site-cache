import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

type TestRule = {
	id?: string;
	description?: string;
	pathPatterns: string[];
	ttl: string;
	groupCode?: string;
	additionalMatchCriteria?: Array<{
		additionalMatchType?: string;
		additionalMatchOperator?: string;
		additionalMatchKey?: string;
		additionalMatchValue?: unknown;
	}>;
};

type MockState = {
	rules: TestRule[];
	created: TestRule[];
	updated: Array<{ id: string; data: TestRule }>;
	onData?: (() => Promise<void>) | undefined;
};

const mockState: MockState = {
	rules: [],
	created: [],
	updated: [],
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('Timed out waiting for asynchronous initialization');
};

const fakeRequest = (url: string, headers: Record<string, string> = {}) =>
	({
		url,
		headers,
	}) as any;

const baseRule = (overrides: Partial<TestRule> = {}): TestRule => ({
	id: 'rule-1',
	description: 'test rule',
	pathPatterns: ['^/products$'],
	ttl: '10m',
	...overrides,
});

let TTLRules: any;
let MATCH_TYPE: any;
let CONDITION_OPERATOR: any;
let classifyRequest: any;

const refreshRules = async (rules: TestRule[]) => {
	mockState.rules = rules;
	await waitFor(() => typeof mockState.onData === 'function');
	await mockState.onData!();
};

before(async () => {
	(globalThis as any).Resource = class {
		getContext() {
			return { _nodeRequest: { url: '/cache/ttlConfig/mock-id' } };
		}
	};

	(globalThis as any).logger = {
		info: () => {},
		debug: () => {},
		error: () => {},
		warn: () => {},
	};

	(globalThis as any).databases = {
		CacheManagement: {
			TTLRules: {
				create: async (data: TestRule) => {
					mockState.created.push(data);
				},
				put: async (id: string, data: TestRule) => {
					mockState.updated.push({ id, data });
				},
				search: async function* () {
					for (const rule of mockState.rules) {
						yield rule;
					}
				},
				subscribe: async () => ({
					on: (event: string, cb: () => Promise<void>) => {
						if (event === 'data') {
							mockState.onData = cb;
						}
					},
				}),
			},
		},
	};

	const ttlModule = await import(`../../src/resources/ttlRules.ts?test=${Date.now()}`);
	TTLRules = ttlModule.TTLRules;
	MATCH_TYPE = ttlModule.MATCH_TYPE;
	CONDITION_OPERATOR = ttlModule.CONDITION_OPERATOR;

	const cacheModule = await import(`../../src/util/cache.ts?test=${Date.now()}`);
	classifyRequest = cacheModule.classifyRequest;

	await waitFor(() => typeof mockState.onData === 'function');
	await refreshRules([]);
});

describe('TTLRules validation', () => {
	test('rejects empty pathPatterns', async () => {
		mockState.created.length = 0;
		const resource = new TTLRules();

		const response = await resource.post(baseRule({ pathPatterns: [] }));
		assert.equal(response.status, 400);
		assert.match(response.data, /pathPatterns must be a non-empty array/);
		assert.equal(mockState.created.length, 0);
	});

	test('rejects invalid regex patterns', async () => {
		mockState.created.length = 0;
		const resource = new TTLRules();

		const response = await resource.post(baseRule({ pathPatterns: ['[invalid'] }));
		assert.equal(response.status, 400);
		assert.match(response.data, /Invalid regex pattern/);
		assert.equal(mockState.created.length, 0);
	});

	test('rejects invalid ttl values', async () => {
		mockState.created.length = 0;
		const resource = new TTLRules();

		const response = await resource.post(baseRule({ ttl: 'abc' }));
		assert.equal(response.status, 400);
		assert.match(response.data, /Invalid ttl value: abc/);
		assert.equal(mockState.created.length, 0);
	});

	test('accepts special ttl values origin_expires and never', async () => {
		mockState.created.length = 0;
		const resource = new TTLRules();

		const originResponse = await resource.post(baseRule({ id: 'origin', ttl: 'origin_expires' }));
		assert.equal(originResponse.status, 204);

		const neverResponse = await resource.post(baseRule({ id: 'never', ttl: 'never' }));
		assert.equal(neverResponse.status, 204);
		assert.equal(mockState.created.length, 2);
	});

	test('rejects invalid additional match type', async () => {
		mockState.created.length = 0;
		const resource = new TTLRules();

		const response = await resource.post(
			baseRule({
				additionalMatchCriteria: [
					{
						additionalMatchType: 'cookie',
						additionalMatchOperator: CONDITION_OPERATOR.EQUALS,
						additionalMatchKey: 'brand',
						additionalMatchValue: 'ae',
					},
				],
			})
		);

		assert.equal(response.status, 400);
		assert.match(response.data, /Invalid additionalMatchType/);
		assert.equal(mockState.created.length, 0);
	});

	test('rejects invalid additional match operator', async () => {
		mockState.created.length = 0;
		const resource = new TTLRules();

		const response = await resource.post(
			baseRule({
				additionalMatchCriteria: [
					{
						additionalMatchType: MATCH_TYPE.QUERY,
						additionalMatchOperator: 'gt',
						additionalMatchKey: 'category',
						additionalMatchValue: 'tops',
					},
				],
			})
		);

		assert.equal(response.status, 400);
		assert.match(response.data, /Invalid additionalMatchOperator/);
		assert.equal(mockState.created.length, 0);
	});

	test('requires value for value-based operators', async () => {
		mockState.created.length = 0;
		const resource = new TTLRules();

		const response = await resource.post(
			baseRule({
				additionalMatchCriteria: [
					{
						additionalMatchType: MATCH_TYPE.HEADER,
						additionalMatchOperator: CONDITION_OPERATOR.CONTAINS,
						additionalMatchKey: 'x-country',
					},
				],
			})
		);

		assert.equal(response.status, 400);
		assert.match(response.data, /additionalMatchValue must be set/);
		assert.equal(mockState.created.length, 0);
	});

	test('allows exists/not_exists operators without a value', async () => {
		mockState.created.length = 0;
		const resource = new TTLRules();

		const existsResponse = await resource.post(
			baseRule({
				id: 'exists',
				additionalMatchCriteria: [
					{
						additionalMatchType: MATCH_TYPE.HEADER,
						additionalMatchOperator: CONDITION_OPERATOR.EXISTS,
						additionalMatchKey: 'x-experiment',
					},
				],
			})
		);

		assert.equal(existsResponse.status, 204);
		assert.equal(mockState.created.length, 1);
	});

	test('put validates payload and writes using id from request path', async () => {
		mockState.updated.length = 0;
		const resource = new TTLRules();
		(resource as any).getContext = () => ({ _nodeRequest: { url: '/cache/ttlConfig/updated-rule' } });

		const response = await resource.put(baseRule({ id: 'ignored-id' }));
		assert.equal(response.status, 204);
		assert.deepEqual(mockState.updated.at(-1), {
			id: 'updated-rule',
			data: baseRule({ id: 'ignored-id' }),
		});
	});
});

describe('TTL rule matching', () => {
	test('matches the most specific rule and memoizes unconditional matches', async () => {
		await refreshRules([
			baseRule({
				id: 'general',
				description: 'general',
				pathPatterns: ['^/api/.*$'],
				ttl: '2m',
			}),
			baseRule({
				id: 'specific',
				description: 'specific',
				pathPatterns: ['^/api/products/.*$'],
				ttl: '10m',
			}),
		]);

		const request = fakeRequest('/api/products/sku-123');
		const first = classifyRequest(request, 'memo-key');
		assert.equal(first?.memo, 'miss');
		assert.equal(first?.ruleId, 'specific');
		assert.equal(first?.ttlSeconds, 600);
		assert.equal(first?.bucketPrefix, '/api/products');

		const second = classifyRequest(request, 'memo-key');
		assert.equal(second?.memo, 'hit');
		assert.equal(second?.ruleId, 'specific');
	});

	test('evaluates query criteria and does not memoize conditional matches', async () => {
		await refreshRules([
			baseRule({
				id: 'query-rule',
				description: 'query rule',
				pathPatterns: ['^/search$'],
				ttl: '1h',
				additionalMatchCriteria: [
					{
						additionalMatchType: MATCH_TYPE.QUERY,
						additionalMatchOperator: CONDITION_OPERATOR.EQUALS,
						additionalMatchKey: 'category',
						additionalMatchValue: 'tops',
					},
				],
			}),
		]);

		const noMatch = classifyRequest(fakeRequest('/search?category=bottoms'), 'query-no-match');
		assert.equal(noMatch, null);

		const firstMatch = classifyRequest(fakeRequest('/search?category=tops'), 'query-match');
		assert.equal(firstMatch?.memo, 'miss');
		assert.equal(firstMatch?.ruleId, 'query-rule');

		const secondMatch = classifyRequest(fakeRequest('/search?category=tops'), 'query-match');
		assert.equal(secondMatch?.memo, 'miss');
	});

	test('evaluates header exists criteria', async () => {
		await refreshRules([
			baseRule({
				id: 'header-rule',
				description: 'header rule',
				pathPatterns: ['^/header-test$'],
				ttl: '30m',
				additionalMatchCriteria: [
					{
						additionalMatchType: MATCH_TYPE.HEADER,
						additionalMatchOperator: CONDITION_OPERATOR.EXISTS,
						additionalMatchKey: 'x-country',
					},
				],
			}),
		]);

		const missingHeader = classifyRequest(fakeRequest('/header-test', {}), 'header-no-match');
		assert.equal(missingHeader, null);

		const withHeader = classifyRequest(fakeRequest('/header-test', { 'x-country': 'US' }), 'header-match');
		assert.equal(withHeader?.ruleId, 'header-rule');
		assert.equal(withHeader?.memo, 'miss');
	});

	test('normalizes incoming path before regex matching', async () => {
		await refreshRules([
			baseRule({
				id: 'path-normalized',
				description: 'path normalized',
				pathPatterns: ['^/normalized/path$'],
				ttl: '5m',
			}),
		]);

		const match = classifyRequest(fakeRequest('/normalized/path/?foo=1'), 'path-normalized-key');
		assert.equal(match?.ruleId, 'path-normalized');
		assert.equal(match?.memo, 'miss');
	});
});

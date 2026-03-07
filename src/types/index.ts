import { SPECIAL_TTL } from '../resources/ttlRules.js';

export interface CacheInvalidationRequest {
	type: 'api' | 'page' | 'cacheTag' | 'url';
	cacheTag?: string;
	url?: string;
	groupCode?: string;
}

export interface TTLRuleMatchConditions {
	type: 'header' | 'query';
	op: 'equals' | 'contains' | 'not_equals' | 'not_contains' | 'exists' | 'not_exists';
	key?: string;
	values?: string | string[];
}

export interface TTLParsed {
	mode: 'ttl' | SPECIAL_TTL;
	seconds: number;
}

export interface TTLRuleIndexEntry {
	id: string;
	name: string;
	patternText: string;
	regex: RegExp;
	prefix: string | null;
	ttl: TTLParsed;
	conds: TTLRuleMatchConditions[];
	specificity: number;
	groupCode: string | null;
}

export interface TTLRulesIndex {
	buckets: Map<string, TTLRuleIndexEntry[]>;
	general: TTLRuleIndexEntry[];
	prefixes: string[];
	rawCount: number;
}

export interface TTLRuleMatchResult {
	policy: 'ttl' | SPECIAL_TTL;
	ttlSeconds: number;
	ruleName: string;
	ruleId: string;
	matchedPattern: string;
	bucketPrefix: string;
	groupCode: string;
}

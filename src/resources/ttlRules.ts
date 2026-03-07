import type { TtlRules } from '../types/graphql.js';

export enum CONDITION_OPERATOR {
	EQUALS = 'equals',
	NOT_EQUALS = 'not_equals',
	CONTAINS = 'contains',
	NOT_CONTAINS = 'not_contains',
	EXISTS = 'exists',
	NOT_EXISTS = 'not_exists',
}

export enum SPECIAL_TTL {
	ORIGIN = 'origin_expires',
	NEVER = 'never',
	NO_CACHE = 'no_cache',
}

export enum MATCH_TYPE {
	HEADER = 'header',
	QUERY = 'query',
}

const isString = (v: any) => typeof v === 'string' || v instanceof String;
const isStringArray = (v: any) => Array.isArray(v) && v.every((x) => typeof x === 'string' || x instanceof String);
const isStringOrStringArray = (v: any) => isString(v) || isStringArray(v);

/**
 * Validate a TTLRule object; returns error message if any validation fails
 */
const validateRule = (rule: TtlRules): string | undefined => {
	// validate regex
	if (!rule.pathPatterns || !Array.isArray(rule.pathPatterns) || rule.pathPatterns.length === 0) {
		return 'pathPatterns must be a non-empty array of regex patterns';
	}

	for (const pat of rule.pathPatterns) {
		try {
			new RegExp(pat!);
		} catch (e) {
			return `Invalid regex pattern: ${pat}; ${(e as any).message}`;
		}
	}

	// validate ttl
	const durationRegex = /^(?:[1-9]\d*)(?:[mhdy])$/i;
	if (rule.ttl !== SPECIAL_TTL.ORIGIN && rule.ttl !== SPECIAL_TTL.NEVER && !durationRegex.test(rule.ttl)) {
		return `Invalid ttl value: ${rule.ttl}; must be a duration like '10m', '1h', '2d', or special values 'origin_expires' or 'never'`;
	}

	// validate conditions
	for (const criterion of rule?.additionalMatchCritera ?? []) {
		if (criterion!.additionalMatchType && !Object.values(MATCH_TYPE).includes(criterion!.additionalMatchType)) {
			return `Invalid additionalMatchType: ${criterion!.additionalMatchType}; must be one of ${Object.values(MATCH_TYPE).join(', ')}`;
		}
		if (
			criterion!.additionalMatchOperator &&
			!Object.values(CONDITION_OPERATOR).includes(criterion!.additionalMatchOperator)
		) {
			return `Invalid additionalMatchOperator: ${criterion!.additionalMatchOperator}; must be one of ${Object.values(CONDITION_OPERATOR).join(', ')}`;
		}
		if (criterion!.additionalMatchValue && !isStringOrStringArray(criterion!.additionalMatchValue)) {
			return `Invalid additionalMatchValue: ${criterion!.additionalMatchValue}; must be a string or array of strings`;
		}
		if (
			criterion!.additionalMatchType &&
			![CONDITION_OPERATOR.EXISTS, CONDITION_OPERATOR.NOT_EXISTS].includes(criterion!.additionalMatchOperator) &&
			!criterion!.additionalMatchValue
		) {
			return 'additionalMatchValue must be set when additionalMatchType and additionalMatchOperator are set to operators other than "exists" or "not_exists"';
		}
	}
};

export class TTLRules extends Resource {
	async post(data: TtlRules) {
		const errorMsg = validateRule(data);
		if (errorMsg) {
			return {
				status: 400,
				data: errorMsg,
			};
		}

		await databases.CacheManagement.TTLRules.create(data);
		return {
			status: 204,
		};
	}

	async put(data: TtlRules) {
		const errorMsg = validateRule(data);
		if (errorMsg) {
			return {
				status: 400,
				data: errorMsg,
			};
		}

		const id = this.getContext()._nodeRequest.url.split('/').pop();
		await databases.CacheManagement.TTLRules.put(id, data);
		return {
			status: 204,
		};
	}
}

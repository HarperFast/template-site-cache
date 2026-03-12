import type { CacheInvalidationRequest } from '../types/index.js';
import { CACHE_INVALIDATION_KEY } from '../constants/index.js';

const { CacheInvalidation: CacheInvalidationTable } = databases.CacheManagement;

const handleDeletes = async (
	table: any,
	queryAttr: string,
	op: 'equals' | 'contains',
	queryVal: string
): Promise<void> => {
	const it = table.search({
		conditions: [
			{
				attribute: queryAttr,
				comparator: op,
				value: queryVal,
			},
		],
		select: ['cacheKey'],
	});

	for await (const record of it) {
		table.delete(record.cacheKey);
	}
};

const handleCacheTagRecordDeletion = async (cacheTag?: string): Promise<(string | number)[]> => {
	if (!cacheTag) return [400, 'cacheTag must not be empty'];

	await Promise.all([
		handleDeletes(databases.APICache.CacheContent, 'cacheTags', 'contains', cacheTag),
		handleDeletes(databases.DefaultCache.CacheContent, 'cacheTags', 'contains', cacheTag)
	]);

	return [200, `Records with cacheTag "${cacheTag}" have been deleted.`];
};

const handleUrlRecordDeletion = async (url?: string): Promise<(string | number)[]> => {
	if (!url) return [400, 'url must not be empty'];

	await Promise.all([
		handleDeletes(databases.APICache.CacheContent, 'url', 'equals', url),
		handleDeletes(databases.DefaultCache.CacheContent, 'url', 'equals', url)
	]);

	return [200, `Records with url "${url}" have been deleted.`];
};

export class Invalidate extends Resource {
	async post(body: CacheInvalidationRequest) {
		const type = body.type;
		if (!['api', 'page', 'cacheTag', 'url'].includes(type)) {
			return { status: 400, data: `Unknown invalidation request for type "${type}" received.` };
		}

		if (type === 'cacheTag') {
			if (!body.cacheTag) return { status: 400, data: 'cacheTag must not be empty' };
			if (body.runAsync) {
				handleCacheTagRecordDeletion(body.cacheTag).catch((err) =>
					logger.error('Async cacheTag invalidation failed', body.cacheTag, err)
				);
				return { status: 202, data: `Async deletion of records with cacheTag "${body.cacheTag}" started.` };
			}
			const [status, msg] = await handleCacheTagRecordDeletion(body.cacheTag);
			return { status: status, data: msg };
		}
		if (type === 'url') {
			if (!body.url) return { status: 400, data: 'url must not be empty' };
			if (body.runAsync) {
				handleUrlRecordDeletion(body.url).catch((err) => logger.error('Async url invalidation failed', body.url, err));
				return { status: 202, data: `Async deletion of records with url "${body.url}" started.` };
			}
			const [status, msg] = await handleUrlRecordDeletion(body.url);
			return { status: status, data: msg };
		}

		const groupCode = body.groupCode;

		const previousInvalidations = await CacheInvalidationTable.get(CACHE_INVALIDATION_KEY);

		const timestamp = Date.now();

		const newInvalidations = { ...previousInvalidations?.timestamps };
		let msg;

		if (groupCode) {
			newInvalidations[groupCode] = timestamp;
			msg = `Group code ${groupCode} records created prior to ${new Date(timestamp).toISOString()} are invalidated.`;
		} else {
			newInvalidations[type] = timestamp;
			msg = `${type} records created prior to ${new Date(timestamp).toISOString()} are invalidated.`;
		}

		await CacheInvalidationTable.put(CACHE_INVALIDATION_KEY, {
			timestamps: newInvalidations,
		});

		return { status: 200, data: msg };
	}
}

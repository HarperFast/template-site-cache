import { Resource } from 'harperdb';
export default class Handler extends Resource {
	// a "Hello, world!" handler
	get(q) {
		const requestPath = q.get('path');
		console.log(this.getContext().headers);
		if (!requestPath) {
			return {
				status: 400,
			};
		}
		// const apiHeaderKey = cacheConfiguration.apiHeader.key ?? '';
		// const apiHeader = request.headers.get(apiHeaderKey) ?? request.headers.get(apiHeaderKey.toLowerCase());
		// if (apiHeader === 'UGP_API' || request.url.includes('/ugp-api/')) {
		// 	return handleAPI(request, cacheInvalidations);
		// }
		// if (requestPath)
		return { greeting: 'Hello, world!' };
	}
}

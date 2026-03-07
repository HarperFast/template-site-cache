/**
 * Decodes a base 64 encoded basic auth header.
 *
 * @param {string} authHeader
 * @returns {object} { username: string, password: string }
 */
export const decodeAuthHeader = (authHeader: string): { username: string; password: string } => {
	if (!authHeader) return { username: '', password: '' };

	// Match "Basic <base64>", case-insensitive, tolerate extra spaces
	const m = RegExp(/^\s*Basic\s+(.+)\s*$/i).exec(authHeader);
	if (!m) return { username: '', password: '' };

	const base64 = m[1];

	let decoded;
	try {
		decoded = Buffer.from(base64, 'base64').toString('utf8');
	} catch {
		return { username: '', password: '' }; // invalid base6
	}

	const sep = decoded.indexOf(':');
	if (sep === -1) {
		// No colon present: whole string is username, empty password
		return { username: decoded, password: '' };
	}

	const username = decoded.slice(0, sep);
	const password = decoded.slice(sep + 1); // keep everything after the first colon

	return { username: username ?? '', password: password ?? '' };
};

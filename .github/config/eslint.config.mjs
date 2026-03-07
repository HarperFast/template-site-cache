import harperESLint from '@harperdb/code-guidelines/eslint';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default [
	...harperESLint,

	// Apply TypeScript-specific override for local tsconfig.json
	{
		files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
		languageOptions: {
			parserOptions: {
				project: 'tsconfig.json',
				tsconfigRootDir: path.resolve(__dirname, '../../'),
			},
		},
	},
];

import { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
	schema: 'src/db//schema.graphql',
	generates: {
		'src/types/graphql.ts': {
			plugins: ['typescript', 'typescript-operations'],
			config: {
				scalars: {
					ID: {
						input: 'string',
						output: 'string | number',
					},
					Date: 'Date',
					Any: '{ [key: string]: any }',
					Long: 'number',
					BigInt: 'number',
					Blob: 'Blob',
					Bytes: 'Uint8Array',
				},
			},
		},
	},
};

export default config;

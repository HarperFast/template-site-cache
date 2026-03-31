export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
	ID: { input: string; output: string | number };
	String: { input: string; output: string };
	Boolean: { input: boolean; output: boolean };
	Int: { input: number; output: number };
	Float: { input: number; output: number };
	Any: { input: { [key: string]: any }; output: { [key: string]: any } };
	Blob: { input: Blob; output: Blob };
	Long: { input: number; output: number };
};

export type CacheContent = {
	__typename?: 'CacheContent';
	cacheKey?: Maybe<Scalars['String']['output']>;
	cacheTags?: Maybe<Scalars['String']['output']>;
	data: Scalars['Blob']['output'];
	debugHeaders?: Maybe<Scalars['String']['output']>;
	groupCode?: Maybe<Scalars['String']['output']>;
	headers: Scalars['String']['output'];
	refreshedAt?: Maybe<Scalars['Long']['output']>;
	url?: Maybe<Scalars['String']['output']>;
};

export type CacheInvalidation = {
	__typename?: 'CacheInvalidation';
	id?: Maybe<Scalars['Int']['output']>;
	timestamps?: Maybe<Scalars['Any']['output']>;
};

export type TtlRules = {
	__typename?: 'TTLRules';
	additionalMatchCriteria?: Maybe<Array<Maybe<Scalars['Any']['output']>>>;
	description?: Maybe<Scalars['String']['output']>;
	groupCode?: Maybe<Scalars['String']['output']>;
	id?: Maybe<Scalars['ID']['output']>;
	pathPatterns: Array<Maybe<Scalars['String']['output']>>;
	ttl: Scalars['String']['output'];
};

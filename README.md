# Harper | Site Cache Component

A rules-driven caching component for Harper that sits between edge traffic and origin services.
It supports:

- HTML/page caching and API caching in separate Harper tables.
- A DB-backed TTL rule engine (regex + optional header/query conditions).
- Cache bypass and debug observability headers.
- Manual and timestamp-based invalidation.
- Environment-based configuration via `cacheConfiguration.<env>.json` files, selected at boot by the `ENVIRONMENT` env var.

## Table of Contents

- [Architecture in Harper](#architecture-in-harper)
- [Request Flow](#request-flow)
- [TTL Rules Engine](#ttl-rules-engine)
- [Harper Schema](#Harper-schema)
- [Cache Configuration Reference](#cache-configuration-reference)
- [Admin Resources](#admin-resources)
- [Invalidation Model](#invalidation-model)
- [Headers and Observability](#headers-and-observability)
- [Authentication Model](#authentication-model)
- [Run and Deploy](#run-and-deploy)
- [Operational Notes](#operational-notes)

## Architecture in Harper

This component is implemented as:

- A global HTTP interceptor in `src/index.ts` using `server.http(...)`.
- Custom resource classes for rule management and invalidation:
  - `CacheConfig` in `src/resources/cacheConfig.ts`
  - `Invalidate` in `src/resources/cacheInvalidation.ts`
- Utility modules for:
  - rule classification (`src/util/cache.ts`)
  - key generation (`src/util/cacheKeys.ts`)
  - header handling (`src/util/headers.ts`)
  - origin fetch pooling (`src/util/originClient.ts`)

Runtime bootstrap behavior:

1. Load request interceptor.
2. Subscribe to TTL rule updates from `TTLRules` and rebuild in-memory index.
3. Subscribe to invalidation timestamps and keep an in-memory invalidation map.

## Request Flow

### 1) Request routing

Incoming traffic is processed by `server.http(...)`:

- Reserved paths bypass cache routing:
  - `/status`
  - `/prometheus_exporter/metrics`
  - `/cache/ttlConfig`
  - `/cache/invalidate`
- Other requests are authenticated using `x-hdb-authorization` (Basic auth).
- Requests are classified as API traffic when either condition matches:
  - a configurable header
  - URL contains configured configurable API prefix
- API requests use `handleAPI(...)`; everything else uses `handleDefault(...)`.

### 2) Cache key generation

Keys are deterministic and configuration-driven:

- Path is normalized:
  - lowercased
  - canonical trailing slash behavior
- Included headers/cookies/query params are controlled by:
  - `defaultCacheKey` for page cache
  - `apiCacheKey` for API cache
- Key parts are sorted for order-independent equality.
- When key length exceeds `KEY_OVERFLOW` (1000 chars), a suffix MD5 hash is added.

### 3) Rule classification

Each request is classified against in-memory TTL rules:

- Path is normalized.
- Candidates are narrowed by longest literal prefix bucket.
- Candidates are checked in descending specificity.
- Optional conditions are evaluated (`header`/`query` + operator).
- First matching rule wins.
- Result is memoized for hot keys (up to 5000 entries) when rule has no conditions.

### 4) Cache read/write behavior

#### API flow (`src/resources/apiCache.ts`)

- `GET` requests can use cache unless `x-harper-cache-bypass: true`.
- Cache hit returns stored payload + stored headers + `x-hdb-cache: hit`.
- Cache miss fetches origin, conditionally stores successful responses (`status === 200` and matching TTL rule), returns `x-hdb-cache: miss`.
- Non-cacheable API responses return `x-hdb-cache: no-cache`.
- Non-GET API methods are proxied without caching.

#### Default/page flow (`src/resources/defaultCache.ts`)

- Computes page cache key and rule match.
- If cacheable and present, returns cached content (`x-hdb-cache: hit`).
- Otherwise fetches origin and stores response when rule exists.
- Unsuccessful origin responses are not cached.

Both flows:

- Strip/normalize non-cache-safe headers.
- Persist optional `groupCode`, `cacheTags`, `url`, and `refreshedAt`.
- Use invalidation timestamps to skip stale entries.

## TTL Rules Engine

TTL rules are defined per row and loaded into memory from the TTL rules table.

### Rule shape

Each rule row supports:

- `id`
- `description`
- `pathPatterns`: array of regex strings
- `ttl`: duration or special policy
- `groupCode` (optional)
- `additionalMatchCritera` (optional)

### TTL values

Supported rule policies in runtime:

- Duration policy: numeric duration converted to seconds.
- `origin_expires`: use upstream `Expires` semantics.
- `never`: no expiration timestamp is set.
- `no_cache`: explicitly disallow caching

Validation on the admin resource currently accepts:

- Durations: `1m`, `6h`, `1d`, `1y` (pattern: integer + `m|h|d|y`)
- Specials: `origin_expires`, `never`, `no_cache`

Note:

- If no TTL rule matches, the request is treated as non-cacheable by default.

### Additional match criteria

`additionalMatchCritera` entries support:

- `additionalMatchType`: `header` or `query`
- `additionalMatchOperator`: `equals`, `not_equals`, `contains`, `not_contains`, `exists`, `not_exists`
- `additionalMatchKey`
- `additionalMatchValue`: string or string array for value-based operators

Current evaluation behavior:

- Multiple criteria in one rule are ANDed.
- `equals` and `not_equals` compare against a single normalized value.
- `contains` and `not_contains` are evaluated against provided value list.
- `exists` and `not_exists` only require key presence/absence.

### Matching algorithm details

Indexing and ranking:

- Regexes are compiled once.
- A literal prefix is extracted from each regex when possible.
- Prefix buckets are sorted longest-first.
- Specificity scoring:
  - base from literal density and path segments
  - +10 weight when conditions are present
- Candidate order is "bucket candidates first, then general rules", each already sorted by specificity.

Memoization:

- In-memory map max size: 5000.
- FIFO-style eviction at overflow.
- Memo is cleared when rules reload.
- Rules with additional conditions are not memoized.

## Harper Schema

Source: `src/db/schema.graphql`

### `DefaultCache.CacheContent`

| Field          | Type      | Notes                                            |
| -------------- | --------- | ------------------------------------------------ |
| `cacheKey`     | `String`  | Primary key                                      |
| `data`         | `Blob!`   | Cached page payload                              |
| `headers`      | `String!` | Serialized response headers                      |
| `debugHeaders` | `String`  | Serialized debug metadata                        |
| `groupCode`    | `String`  | Optional grouped invalidation key                |
| `cacheTags`    | `String`  | Optional cache tags extracted from origin header |
| `url`          | `String`  | Source URL                                       |
| `refreshedAt`  | `Long`    | Last write timestamp                             |

### `APICache.CacheContent`

| Field          | Type      | Notes                             |
| -------------- | --------- | --------------------------------- |
| `cacheKey`     | `String`  | Primary key                       |
| `data`         | `Blob!`   | Cached API payload                |
| `headers`      | `String!` | Serialized response headers       |
| `debugHeaders` | `String`  | Serialized debug metadata         |
| `groupCode`    | `String`  | Optional grouped invalidation key |
| `cacheTags`    | `String`  | Optional cache tags               |
| `url`          | `String`  | Source URL                        |
| `refreshedAt`  | `Long`    | Last write timestamp              |

### `CacheManagement.TTLRules`

| Field                    | Type        | Notes                                  |
| ------------------------ | ----------- | -------------------------------------- |
| `id`                     | `ID`        | Primary key                            |
| `description`            | `String`    | Human-readable label                   |
| `pathPatterns`           | `[String]!` | Regex list                             |
| `ttl`                    | `String!`   | Duration or special policy             |
| `groupCode`              | `String`    | Optional grouped invalidation key      |
| `additionalMatchCritera` | `[Any]`     | Optional conditional matching criteria |

### `CacheManagement.CacheInvalidation`

| Field        | Type  | Notes                                                                 |
| ------------ | ----- | --------------------------------------------------------------------- |
| `id`         | `Int` | Primary key (record `1` is used by invalidation flow)                 |
| `timestamps` | `Any` | Map of invalidation timestamps by key (`api`, `page`, or `groupCode`) |

## Cache Configuration Reference

### File naming and environment selection

Configuration is split into per-environment files named `cacheConfiguration.<env>.json`. The active file is selected at boot using the `ENVIRONMENT` environment variable:

```bash
ENVIRONMENT=prod    # loads cacheConfiguration.prod.json
ENVIRONMENT=stage   # loads cacheConfiguration.stage.json
ENVIRONMENT=integration  # loads cacheConfiguration.integration.json
# unset or empty   # defaults to cacheConfiguration.local.json
```

Create one file per environment you deploy to. A minimal set looks like:

```
cacheConfiguration.local.json       ← local dev (default when ENVIRONMENT is unset)
cacheConfiguration.stage.json
cacheConfiguration.prod.json
cacheConfiguration.integration.json ← used when running integration tests
```

If the resolved file does not exist, the app will throw at startup with a clear error indicating which file it tried to load.

### Setting ENVIRONMENT in your deployment

Set the `ENVIRONMENT` variable wherever your Harper process is launched. Examples:

**Shell / systemd:**

```bash
ENVIRONMENT=prod harperdb run .
```

**Docker:**

```dockerfile
ENV ENVIRONMENT=prod
```

**docker-compose:**

```yaml
environment:
  - ENVIRONMENT=prod
```

**Harper `config.yaml` (via `loadEnv.files: .env`):**

```bash
# .env
ENVIRONMENT=prod
```

### Example file (`cacheConfiguration.stage.json`)

```json
{
	"cacheTagsHeader": "X-Origin-Cache-Tags",
	"apiPathPrefix": "/api/",
	"apiHeader": { "key": "X-Fwd-Origin", "value": "API" },
	"apiPathReplacement": { "search": "/api/", "replace": "" },
	"apiOrigin": "https://api.staging.example.com",
	"apiOriginAuthHeader": "",
	"apiCacheKey": {
		"includeHeaders": ["accept", "origin", "version"],
		"includeQueryParams": "ALL",
		"includeCookies": []
	},
	"defaultOrigin": "https://www.harper.fast",
	"defaultOriginAuthHeader": "",
	"defaultPathReplacement": false,
	"defaultCacheKey": {
		"includeHeaders": ["device-type", "accept-language"],
		"includeQueryParams": ["sort", "page", "filter"],
		"includeCookies": ["brand"]
	}
}
```

### Field-by-field behavior

| Key                       | Purpose                                                                                  | Required                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `cacheTagsHeader`         | Response header name read from origin to persist cache tags in records.                  | No                                                                         |
| `apiPathPrefix`           | URL substring used to classify requests as API traffic.                                  | Conditional: required if `apiOrigin` is set and `apiHeader` is not set     |
| `apiHeader`               | Header-based API classifier object (`key` + `value`).                                    | Conditional: required if `apiOrigin` is set and `apiPathPrefix` is not set |
| `apiPathReplacement`      | Rewrites incoming API path before forwarding to API origin.                              | No                                                                         |
| `apiOrigin`               | API origin base URL string (e.g. `https://api.example.com`).                             | No                                                                         |
| `apiOriginAuthHeader`     | Optional header name sent to API origin for auth token forwarding.                       | Optional; if set, token env var is required                                |
| `apiCacheKey`             | API cache key config object (`includeHeaders`, `includeQueryParams`, `includeCookies`).  | Conditional: required if `apiOrigin` is set                                |
| `defaultOrigin`           | Default/page origin base URL string (e.g. `https://www.example.com`).                    | Yes                                                                        |
| `defaultOriginAuthHeader` | Optional header name sent to default origin for auth token forwarding.                   | Optional; if set, token env var is required                                |
| `defaultPathReplacement`  | Rewrites default/page path before forwarding to default origin.                          | No                                                                         |
| `defaultCacheKey`         | Page cache key config object (`includeHeaders`, `includeQueryParams`, `includeCookies`). | Yes                                                                        |

If `apiOriginAuthHeader` is set, provide one of as an env var:

- `HDB_API_ORIGIN_AUTH_TOKEN`
- `API_ORIGIN_AUTH_TOKEN`

If `defaultOriginAuthHeader` is set, provide one of as an env var:

- `HDB_DEFAULT_ORIGIN_AUTH_TOKEN`
- `DEFAULT_ORIGIN_AUTH_TOKEN`

## Admin Resources

The module exports:

- `cache.config` for TTL rule writes
- `cache.invalidate` for cache invalidation operations

Path mapping depends on Harper resource export conventions in your deployment.
With default nested-export routing, this is typically:

- `POST /cache/ttlConfig`
- `PUT /cache/ttlConfig/:id`
- `POST /cache/invalidate`

### `cache.config` request body

```json
{
	"description": "Category API responses",
	"pathPatterns": ["^.*/catalog/v\\d+/category/.+$"],
	"ttl": "6h",
	"groupCode": "catalog",
	"additionalMatchCritera": [
		{
			"additionalMatchType": "query",
			"additionalMatchOperator": "equals",
			"additionalMatchKey": "catNav",
			"additionalMatchValue": "L4"
		}
	]
}
```

Expected behavior:

- `POST`: create rule
- `PUT`: upsert by `:id`
- Validation errors return `400` with message text.
- Success returns `204`.

## Invalidation Model

`cache.invalidate` expects JSON body:

```json
{
	"type": "api | page | cacheTag | url",
	"groupCode": "optional-group",
	"cacheTag": "required-when-type-cacheTag",
	"url": "required-when-type-url"
}
```

### `type: api` or `type: page` (soft invalidation)

- Does not delete cache rows.
- Writes an invalidation timestamp into `CacheInvalidation.timestamps`.
- The app subscribes to this table and keeps the latest timestamps in memory.
- Any cache record with `refreshedAt < timestamp` is treated as expired on read.
- If `groupCode` is provided, the timestamp is stored by `groupCode` instead of global `api`/`page` key.
- This model reduces write volume for mass invalidation because it avoids record-by-record deletes.

### `type: cacheTag` (hard invalidation)

- Immediately deletes records in both cache tables matching `cacheTags contains <tag>`.

### `type: url` (hard invalidation)

- Immediately deletes records in both cache tables matching `url == <url>`.

### Individual record deletion by cache key

- You can directly delete a single cache row by `cacheKey` using Harper Operations API `delete`.
- Operations API reference: [Delete (NoSQL)](https://docs.harperdb.io/docs/developers/operations-api/nosql-operations#delete)

## Headers and Observability

### Control headers

- `x-harper-cache-bypass: true`
  - Bypass cache and fetch origin directly.
- `x-hdb-cache-debug: true`
  - Include detailed cache debug headers in response.

### Response headers

- `x-hdb: true`
- `x-hdb-cache: hit | miss | no-cache`
- Debug headers when enabled:
  - `x-hdb-cache-path`
  - `x-hdb-cache-rule`
  - `x-hdb-cache-rule-id`
  - `x-hdb-cache-policy`
  - `x-hdb-cache-ttl`
  - `x-hdb-cache-bucket`
  - `x-hdb-cache-pattern`
  - `x-hdb-cache-key`
  - `x-hdb-cache-ttl-remaining-sec`

## Authentication Model

For non-reserved paths, the interceptor reads:

- `authorization: Basic <base64(username:password)>`

Then calls `server.authenticateUser(username, password)`.

Example:

```text
HDB_ADMIN:password -> Basic SERCX0FETUlOOnBhc3N3b3Jk
```

```http
authorization: Basic SERCX0FETUlOOnBhc3N3b3Jk
```

### Required roles

The component enforces role-based access via `ALLOWED_ROLES`:

```ts
ALLOWED_ROLES = ['cache_user', 'super_user'];
```

Requests authenticated with a user that does not hold one of these roles will be rejected. To grant access to a user:

1. Create the user in Harper with the appropriate role, or assign an existing user the `cache_user` or `super_user` role.
2. Harper's built-in `super_user` role has full access. For restricted access, use `cache_user`.

See [Configuring Roles](https://docs.harperdb.io/docs/reference/roles#configuring-roles) in the Harper documentation for how to create and assign custom roles.

## Run and Deploy

### Local dev

```bash
npm install
npm run build
npm run dev
```

### Tests

```bash
npm run test:unit
```

### Harper app wiring

`config.yaml` currently sets:

- `rest: true`
- `graphqlSchema.files: src/db/schema.graphql`
- `jsResource.files: dist/resources/index.js`
- `loadEnv.files: .env`

Ensure build output and resource entrypoints are aligned with your deployment target.

## Operational Notes

- Rules are hot-reloaded via table subscriptions; restart is not required for rule edits.
- Invalidation timestamps are in-memory plus table-backed; using record id `1` keeps semantics simple.
- Cache keys intentionally include only configured dimensions to avoid cardinality blowups.
- Keep regex patterns as specific as possible to minimize candidate scans and false matches.

## Test Suites

### Unit tests

Validates isolated utility and rules logic.

```bash
npm run test:unit
```

### Integration tests

Validates end-to-end cache behavior against a running Harper instance with mocked origins.

```bash
npm run test:integration
```

Minimum local environment (in the shell running tests):

```bash
export TEST_DOMAIN=http://localhost:9926
export HDB_ADMIN_USERNAME=HDB_ADMIN
export HDB_ADMIN_PASSWORD=password
```

The integration tests expect Harper to be configured with `cacheConfiguration.integration.json`, which points mock origins to `172.17.0.1:4101` (default) and `172.17.0.1:4102`. Set `ENVIRONMENT=integration` in the shell where Harper is running:

```bash
# Shell running Harper
export ENVIRONMENT=integration
harperdb run .
```

The mock origin host and port are configurable via env vars in the test shell if your network differs from the defaults (e.g. non-Docker local setups):

```bash
# Shell running tests — override if mock origins are not on 172.17.0.1
export MOCK_ORIGIN_HOST=127.0.0.1
export MOCK_DEFAULT_ORIGIN_PORT=4101
export MOCK_API_ORIGIN_PORT=4102
```

If you need a fully local setup with different origin URLs, create a `cacheConfiguration.local.json` pointing to your local mock addresses and run Harper with `ENVIRONMENT=local` (or unset).

See `tests/integration/README.md` for the full local two-terminal setup.

### Performance tests (k6)

Ramps to target RPS and round-robins requests across provided hosts.

```bash
k6 run tests/performance/ramp-round-robin.test.js \
  -e HOSTS=https://localhost:9926,https://localhost:9936 \
  -e REQUEST_PATHS=/,/api/it/load/products?foo=bar \
  -e TARGET_RPS=250 \
  -e RAMP_UP_DURATION=2m \
  -e TARGET_DURATION=8m
```

To simulate origin behavior without calling external origins, run Harper with:

```bash
export HDB_LOAD_TEST_MODE=true
```

See `tests/performance/README.md` for all k6 options.

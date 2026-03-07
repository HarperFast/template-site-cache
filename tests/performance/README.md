# Performance Tests (k6)

This folder contains k6 scripts for load testing the deployed Harper component.

## Script

- `ramp-round-robin.test.js`
  - Ramps to a target requests/second rate.
  - Holds that target for a target duration.
  - Rotates requests round-robin across configured hostnames.

## Run Example

```bash
k6 run tests/performance/ramp-round-robin.test.js \
  -e HOSTS=https://localhost:9926,https://localhost:9936 \
  -e REQUEST_PATHS=/it/load/page?sort=popular&page=1&filter=shirts,/api/it/load/products?foo=bar \
  -e TARGET_RPS=250 \
  -e RAMP_UP_DURATION=2m \
  -e TARGET_DURATION=8m \
  -e HDB_ADMIN_USERNAME=HDB_ADMIN \
  -e HDB_ADMIN_PASSWORD=password
```

## k6 Env Vars

- `HOSTS` or `TARGET_HOSTS`: comma-separated hosts (with or without protocol).
- `REQUEST_PATHS` or `PATHS`: comma-separated request paths.
- `TARGET_RPS`: target requests/sec (default `200`).
- `START_RPS`: starting requests/sec during ramp (default `1`).
- `RAMP_UP_DURATION`: ramp duration (default `1m`).
- `TARGET_DURATION`: hold duration (default `5m`).
- `PRE_ALLOCATED_VUS`: preallocated VUs for arrival-rate executor.
- `MAX_VUS`: max VUs for arrival-rate executor.
- `REQUEST_METHOD`: HTTP method (default `GET`).
- `EXPECTED_STATUS`: check target status code (default `200`).
- `SEND_HDB_AUTH`: send `x-hdb-authorization` header (`true` by default).
- `HDB_ADMIN_USERNAME`, `HDB_ADMIN_PASSWORD`: credentials used for `x-hdb-authorization`.
- `REQUEST_BODY`: request body for methods with body.

## Harper Load Test Mode

Set this on Harper runtime to mock origin fetches instead of real network calls:

- `HDB_LOAD_TEST_MODE=true`

When enabled, `fetchFromOrigin(...)` returns a mocked streamed response with:

- random website-sized payload bytes
- random network-like delay
- `200` status

No additional load-test environment configuration is required.

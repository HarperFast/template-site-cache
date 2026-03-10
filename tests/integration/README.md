# Integration Tests

This suite assumes Harper is already running and deployed, and uses mocked origins started by the test process.

## Local Run (Harper as local process)

Use two terminals.

### Terminal 1: Start Harper with the integration config

```bash
export ENVIRONMENT=integration

# start Harper in your normal way, for example:
harperdb dev .
```

`cacheConfiguration.integration.json` points mock origins to `172.17.0.1:4101` and `172.17.0.1:4102` by default. If your local setup needs different addresses, edit that file or create a `cacheConfiguration.local.json` and run with `ENVIRONMENT=local`.

If Harper was already running, restart it after setting `ENVIRONMENT`.

### Terminal 2: Run integration tests

```bash
export MOCK_BIND_HOST=0.0.0.0
export MOCK_ORIGIN_HOST=127.0.0.1
export MOCK_DEFAULT_ORIGIN_PORT=4101
export MOCK_API_ORIGIN_PORT=4102

npm run test:integration
```

`HDB_OPERATIONS_URL` must point directly to Harper's Operations API port (default `9925`), which bypasses the cache component's HTTP interceptor. The test suite drops `DefaultCache`, `APICache`, and `CacheManagement` then restarts Harper at the start of each run to ensure a clean slate.

If your Harper endpoint is different, change `TEST_DOMAIN` accordingly.

## CI Notes

In GitHub Actions, Harper runs in Docker with `ENVIRONMENT=integration`. The `cacheConfiguration.integration.json` file points to `172.17.0.1` (the Docker bridge gateway), which is reachable from within the container when mock origins are bound to `0.0.0.0` on the host.

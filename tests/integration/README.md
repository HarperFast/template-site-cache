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

If Harper was already running, restart it after setting `ENVIRONMENT`.

### Terminal 2: Run integration tests

```bash
export TEST_DOMAIN=http://localhost:9926
export HDB_ADMIN_USERNAME=HDB_ADMIN
export HDB_ADMIN_PASSWORD=0000
export MOCK_BIND_HOST=0.0.0.0
export MOCK_ORIGIN_HOST=127.0.0.1
export MOCK_DEFAULT_ORIGIN_PORT=4101
export MOCK_API_ORIGIN_PORT=4102

npm run test:integration
```

`HDB_OPERATIONS_URL` must point directly to Harper's Operations API port (default `9925`), which bypasses the cache component's HTTP interceptor. The test suite drops `DefaultCache`, `APICache`, and `CacheManagement` then restarts Harper at the start of each run to ensure a clean slate.

If your Harper endpoint is different, change `TEST_DOMAIN` accordingly.

## CI Notes

In GitHub Actions, Harper runs in Docker with `ENVIRONMENT=integration`. The `cacheConfiguration.integration.json` file points to `host.docker.internal`, which resolves to the runner host from inside the container (via `--add-host=host.docker.internal:host-gateway`). On macOS with Docker Desktop, `host.docker.internal` resolves to `127.0.0.1`, so the same config works for local runs.

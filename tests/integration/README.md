# Integration Tests

This suite assumes Harper is already running and deployed, and uses mocked origins started by the test process.

## Local Run (Harper as local process)

Use two terminals.

### Terminal 1: Start Harper with origin overrides

```bash
export ENVIRONMENT=stage
export HDB_ADMIN_USERNAME=HDB_ADMIN
export HDB_ADMIN_PASSWORD=password
export CACHE_DEFAULT_ORIGIN_OVERRIDE=http://127.0.0.1:4101
export CACHE_API_ORIGIN_OVERRIDE=http://127.0.0.1:4102

# start Harper in your normal way, for example:
harperdb dev .
```

If Harper was already running, restart it after setting these variables.

### Terminal 2: Run integration tests

```bash
export TEST_DOMAIN=http://localhost:9926
export HDB_ADMIN_USERNAME=HDB_ADMIN
export HDB_ADMIN_PASSWORD=password
export MOCK_BIND_HOST=127.0.0.1
export MOCK_ORIGIN_HOST=127.0.0.1
export MOCK_DEFAULT_ORIGIN_PORT=4101
export MOCK_API_ORIGIN_PORT=4102

npm run test:integration
```

If your Harper endpoint is different, change `TEST_DOMAIN` accordingly.

## CI Notes

In GitHub Actions, Harper runs in Docker and should receive:

- `CACHE_DEFAULT_ORIGIN_OVERRIDE=http://host.docker.internal:4101`
- `CACHE_API_ORIGIN_OVERRIDE=http://host.docker.internal:4102`

This forces mocked origins for integration tests instead of values from `cacheConfiguration.json`.

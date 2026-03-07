import http from 'k6/http';
import exec from 'k6/execution';
import { b64encode } from 'k6/encoding';
import { check } from 'k6';

const parseNumber = (value, fallback) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const parseList = (value, fallback) => {
	if (!value) return fallback;
	const items = String(value)
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length ? items : fallback;
};

const normalizeHost = (host) => {
	const trimmed = String(host).trim().replace(/\/+$/, '');
	if (!trimmed) return '';
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
};

const normalizePath = (path) => {
	const value = String(path).trim();
	if (!value) return '/';
	return value.startsWith('/') ? value : `/${value}`;
};

const TARGET_RPS = parseNumber(__ENV.TARGET_RPS, 200);
const START_RPS = parseNumber(__ENV.START_RPS, 1);
const RAMP_UP_DURATION = __ENV.RAMP_UP_DURATION || '1m';
const TARGET_DURATION = __ENV.TARGET_DURATION || '5m';
const REQUEST_METHOD = String(__ENV.REQUEST_METHOD || 'GET').toUpperCase();
const EXPECTED_STATUS = parseNumber(__ENV.EXPECTED_STATUS, 200);

const HOSTS = parseList(__ENV.HOSTS || __ENV.TARGET_HOSTS, ['https://localhost:9926']).map(normalizeHost);
const PATHS = parseList(__ENV.REQUEST_PATHS || __ENV.PATHS, ['/']).map(normalizePath);

const PRE_ALLOCATED_VUS = parseNumber(__ENV.PRE_ALLOCATED_VUS, Math.max(50, TARGET_RPS * 2));
const MAX_VUS = parseNumber(__ENV.MAX_VUS, Math.max(PRE_ALLOCATED_VUS, TARGET_RPS * 10));

const SEND_HDB_AUTH = !['0', 'false', 'no'].includes(String(__ENV.SEND_HDB_AUTH || 'true').toLowerCase());
const HDB_ADMIN_USERNAME = __ENV.HDB_ADMIN_USERNAME || 'HDB_ADMIN';
const HDB_ADMIN_PASSWORD = __ENV.HDB_ADMIN_PASSWORD || 'password';
const AUTH_HEADER = `Basic ${b64encode(`${HDB_ADMIN_USERNAME}:${HDB_ADMIN_PASSWORD}`)}`;

const REQUEST_BODY = __ENV.REQUEST_BODY || JSON.stringify({ source: 'k6-load-test' });

export const options = {
	scenarios: {
		ramp_round_robin_hosts: {
			executor: 'ramping-arrival-rate',
			timeUnit: '1s',
			startRate: START_RPS,
			preAllocatedVUs: PRE_ALLOCATED_VUS,
			maxVUs: MAX_VUS,
			stages: [
				{ target: TARGET_RPS, duration: RAMP_UP_DURATION },
				{ target: TARGET_RPS, duration: TARGET_DURATION },
			],
		},
	},
	thresholds: {
		http_req_failed: ['rate<0.02'],
		http_req_duration: ['p(95)<3000'],
	},
};

export default function () {
	const iteration = exec.scenario.iterationInTest;
	const host = HOSTS[iteration % HOSTS.length];
	const path = PATHS[iteration % PATHS.length];
	const url = `${host}${path}`;

	const headers = {
		accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
	};
	if (SEND_HDB_AUTH) {
		headers['x-hdb-authorization'] = AUTH_HEADER;
	}

	const payload = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(REQUEST_METHOD) ? REQUEST_BODY : null;
	const response = http.request(REQUEST_METHOD, url, payload, {
		headers,
		tags: {
			host,
			path,
			method: REQUEST_METHOD,
		},
	});

	check(response, {
		'status is expected': (r) => r.status === EXPECTED_STATUS,
		'latency under 5s': (r) => r.timings.duration < 5000,
	});
}

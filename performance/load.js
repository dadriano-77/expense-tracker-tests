import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate   = new Rate('errors');
const loginTime   = new Trend('login_duration',   true);
const expenseTime = new Trend('expense_duration', true);

export const options = {
  stages: [
    { duration: '30s', target: 5  },
    { duration: '60s', target: 10 },
    { duration: '30s', target: 0  },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    errors:            ['rate<0.05'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:3001';

function register(username) {
  return http.post(
    `${BASE}/api/auth/register`,
    JSON.stringify({ username, password: 'Perf1234!' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function login(username) {
  const start = Date.now();
  const res = http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ username, password: 'Perf1234!' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  loginTime.add(Date.now() - start);
  return res;
}

export function setup() {
  register(`perf_setup_${Date.now()}`);
}

export default function () {
  const username = `perf_${__VU}_${__ITER}`;

  register(username);

  const loginRes = login(username);
  check(loginRes, { 'login 200': r => r.status === 200 });
  errorRate.add(loginRes.status !== 200);

  if (loginRes.status !== 200) { sleep(1); return; }

  const token   = loginRes.json('token');
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const catRes = http.post(
    `${BASE}/api/categories`,
    JSON.stringify({ name: 'Food', color: '#FF5733' }),
    { headers },
  );
  check(catRes, { 'create category 200/201': r => [200, 201].includes(r.status) });
  errorRate.add(![200, 201].includes(catRes.status));

  const catId = catRes.json('id');

  const start = Date.now();
  const expRes = http.post(
    `${BASE}/api/expenses`,
    JSON.stringify({ amount: 25.00, description: 'k6 test', category_id: catId, date: '2024-01-15' }),
    { headers },
  );
  expenseTime.add(Date.now() - start);
  check(expRes, { 'create expense 200/201': r => [200, 201].includes(r.status) });
  errorRate.add(![200, 201].includes(expRes.status));

  http.get(`${BASE}/api/expenses`, { headers });
  http.get(`${BASE}/api/categories`, { headers });
  http.get(`${BASE}/api/budgets`, { headers });

  http.get(`${BASE}/health`);

  sleep(1);
}

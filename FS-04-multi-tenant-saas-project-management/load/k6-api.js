// FlowBoard API load test (k6). Realistic user sessions with think time and rising concurrency.
//
//   docker run --rm -i --network host -e BASE=http://localhost:18081 -v "$PWD/load:/scripts" grafana/k6 run /scripts/k6-api.js
//
// Run it against an isolated stack (docker compose -p <name>), never against data you care about: it creates issues,
// reports and a webhook endpoint. Auth endpoints are rate limited per IP (login 5/min, refresh 30/min) and k6 runs
// from one IP, so logins happen in setup() and the auth scenario runs at a rate under those limits.
import http from "k6/http";
import { check, sleep, group } from "k6";
import { Trend } from "k6/metrics";

const BASE = (__ENV.BASE || "http://localhost:18081") + "/api";
const WS = "acme";
const USERS = ["owner@acme.test", "admin@acme.test"];
const PASSWORD = "Demo@1234";

const loginTime = new Trend("flow_login", true);
const refreshTime = new Trend("flow_refresh", true);

export const options = {
  scenarios: {
    // Signed-in users browsing and editing: 1 → 10 → 25 → 50 concurrent users, then back down.
    users: {
      executor: "ramping-vus",
      exec: "userSession",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 10 },
        { duration: "1m", target: 10 },
        { duration: "30s", target: 25 },
        { duration: "1m", target: 25 },
        { duration: "30s", target: 50 },
        { duration: "1m", target: 50 },
        { duration: "20s", target: 0 },
      ],
    },
    // Login + token refresh at a steady 4/min (under the per-IP login limit of 5/min).
    auth: { executor: "constant-arrival-rate", exec: "authFlow", rate: 4, timeUnit: "1m", duration: "4m",
            preAllocatedVUs: 2, startTime: "30s" },
    // Report generation (rate limited to 10/hour per user): a handful during the peak.
    reports: { executor: "shared-iterations", exec: "reportFlow", vus: 1, iterations: 4, startTime: "3m", maxDuration: "2m" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:read}": ["p(95)<500"],
    "http_req_duration{kind:write}": ["p(95)<800"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

function json(res) { try { return res.json(); } catch (_) { return null; } }

function login(email) {
  const res = http.post(`${BASE}/auth/login/`, JSON.stringify({ email, password: PASSWORD }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "POST /auth/login/", kind: "auth" } });
  check(res, { "login 200": (r) => r.status === 200 });
  return json(res);
}

export function setup() {
  const sessions = USERS.map((email) => login(email));
  const h = { Authorization: `Bearer ${sessions[0].access}`, "X-Workspace": WS, "Content-Type": "application/json" };
  const projects = json(http.get(`${BASE}/projects/`, { headers: h }));
  const list = projects.results || projects;
  const web = list.find((p) => p.key === "WEB");
  // A webhook endpoint subscribed to issue events, so issue writes also exercise webhook delivery in the worker.
  // The .invalid host never resolves (RFC 2606): deliveries fail and retry without sending data anywhere.
  const hook = http.post(`${BASE}/webhooks/`, JSON.stringify({ name: "k6 load", url: "https://k6-load.invalid/hook",
    events: ["issue.created", "issue.updated"] }), { headers: h });
  return { tokens: sessions.map((s) => s.access), projectId: web.id, webhookId: (json(hook) || {}).id };
}

export function userSession(data) {
  const token = data.tokens[__VU % data.tokens.length];
  const h = { Authorization: `Bearer ${token}`, "X-Workspace": WS, "Content-Type": "application/json", "Accept-Encoding": "gzip" };
  const read = (name, url) => {
    const res = http.get(url, { headers: h, tags: { name, kind: "read" } });
    check(res, { [`${name} 200`]: (r) => r.status === 200 });
    return res;
  };
  group("browse", () => {
    read("GET /auth/me/", `${BASE}/auth/me/`);
    read("GET /projects/", `${BASE}/projects/`);
    read("GET /boards/", `${BASE}/boards/?project=${data.projectId}`);
    read("GET /issues/ (board)", `${BASE}/issues/?project=WEB&sprint=active`);  // what the board loads
    read("GET /dashboard/", `${BASE}/dashboard/`);
    read("GET /notifications/", `${BASE}/notifications/`);
  });
  sleep(1 + Math.random() * 2); // think time
  if (Math.random() < 0.3) {
    group("edit", () => {
      const created = http.post(`${BASE}/issues/`, JSON.stringify({ project: data.projectId, title: `k6 issue ${__VU}-${__ITER}` }),
        { headers: h, tags: { name: "POST /issues/", kind: "write" } });
      check(created, { "create issue 201": (r) => r.status === 201 });
      const key = (json(created) || {}).key;
      if (key) {
        const upd = http.patch(`${BASE}/issues/${key}/`, JSON.stringify({ priority: 4 }),
          { headers: h, tags: { name: "PATCH /issues/{key}/", kind: "write" } });
        check(upd, { "update issue 200": (r) => r.status === 200 });
      }
    });
    sleep(1 + Math.random() * 2);
  }
}

export function authFlow() {
  const t0 = Date.now();
  const tokens = login(USERS[0]);
  loginTime.add(Date.now() - t0);
  if (!tokens) return;
  const t1 = Date.now();
  const res = http.post(`${BASE}/auth/refresh/`, JSON.stringify({ refresh: tokens.refresh }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "POST /auth/refresh/", kind: "auth" } });
  refreshTime.add(Date.now() - t1);
  check(res, { "refresh 200": (r) => r.status === 200, "refresh rotated": (r) => !!(json(r) || {}).refresh });
}

export function reportFlow(data) {
  const h = { Authorization: `Bearer ${data.tokens[1]}`, "X-Workspace": WS, "Content-Type": "application/json" };
  const res = http.post(`${BASE}/reports/`, JSON.stringify({ report_type: "workspace_summary" }),
    { headers: h, tags: { name: "POST /reports/", kind: "write" } });
  check(res, { "report accepted": (r) => r.status === 201 || r.status === 202 || r.status === 200 });
  const id = (json(res) || {}).id;
  // Wait for the worker to build it (or for an existing identical report to be returned).
  for (let i = 0; i < 20 && id; i++) {
    sleep(1);
    const s = json(http.get(`${BASE}/reports/${id}/`, { headers: h, tags: { name: "GET /reports/{id}/", kind: "read" } }));
    if (s && (s.state === "ready" || s.state === "failed")) {
      check(s, { "report ready": (x) => x.state === "ready" });
      break;
    }
  }
  sleep(20);
}

export function teardown(data) {
  const h = { Authorization: `Bearer ${data.tokens[0]}`, "X-Workspace": WS };
  if (data.webhookId) {
    const d = json(http.get(`${BASE}/webhooks/${data.webhookId}/deliveries/`, { headers: h }));
    const rows = (d && (d.results || d)) || [];
    console.log(`webhook deliveries recorded during the test: ${d && d.count !== undefined ? d.count : rows.length}`);
  }
}

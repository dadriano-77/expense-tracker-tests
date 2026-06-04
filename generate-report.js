#!/usr/bin/env node
// Reads JSON artifacts from each test stage and produces a single self-contained HTML report.
// Usage: node generate-report.js <reports-dir>

'use strict';

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = process.argv[2] || path.join(__dirname, 'reports');
const OUT_FILE    = path.join(REPORTS_DIR, 'pipeline-report.html');

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(file) {
  const full = path.join(REPORTS_DIR, file);
  if (!fs.existsSync(full)) return null;
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return null; }
}

function fmtMs(ms) {
  if (ms == null || ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtNum(n) {
  return n == null ? '—' : String(n);
}

function statusBadge(status) {
  const cls = status === 'PASS' ? 'badge-pass' : status === 'FAIL' ? 'badge-fail' : 'badge-skip';
  return `<span class="badge ${cls}">${status}</span>`;
}

// ── Load artefacts ────────────────────────────────────────────────────────────

const meta       = readJSON('pipeline-run.json') || {};
const unit       = readJSON('unit/results.json');
const comp       = readJSON('component/results.json');
const expensesNM = readJSON('contract/expenses-results.json');
const playwright = readJSON('e2e/results.json');
const k6         = readJSON('performance/summary.json');
const zap        = readJSON('security/zap-report.json');

// ── Parse Jest ────────────────────────────────────────────────────────────────

function parseJest(data, label) {
  if (!data) return { label, total: 0, passed: 0, failed: 0, duration: 0, suites: [] };
  const suites = (data.testResults || []).map(s => ({
    file: path.basename(s.testFilePath || s.name || ''),
    passed: s.numPassingTests || 0,
    failed: s.numFailingTests || 0,
    duration: s.perfStats ? s.perfStats.end - s.perfStats.start : 0,
    tests: (s.testResults || []).map(t => ({
      name: t.fullName || t.title,
      status: t.status === 'passed' ? 'PASS' : t.status === 'failed' ? 'FAIL' : 'SKIP',
      duration: t.duration || 0,
    })),
  }));
  return {
    label,
    total:    data.numTotalTests    || 0,
    passed:   data.numPassedTests   || 0,
    failed:   data.numFailedTests   || 0,
    duration: data.testResults
      ? data.testResults.reduce((s, r) => s + (r.perfStats ? r.perfStats.end - r.perfStats.start : 0), 0)
      : 0,
    suites,
  };
}

const unitData = parseJest(unit, 'Unit Tests');
const compData = parseJest(comp, 'Component Tests');

// ── Parse Newman ──────────────────────────────────────────────────────────────

function parseNewman(data, label) {
  if (!data) return { label, total: 0, passed: 0, failed: 0, duration: 0, requests: [] };
  const stats = data.run && data.run.stats;
  const timings = data.run && data.run.timings;
  const reqs = [];
  (data.run && data.run.executions || []).forEach(ex => {
    const item = ex.item || {};
    const resp = ex.response || {};
    const assertions = (ex.assertions || []).map(a => ({
      name: a.assertion,
      pass: !a.error,
    }));
    reqs.push({
      name: item.name || '',
      method: (ex.request && ex.request.method) || '',
      status: resp.code || 0,
      time: resp.responseTime || 0,
      pass: assertions.every(a => a.pass),
      assertions,
    });
  });
  return {
    label,
    total:    stats && stats.assertions ? stats.assertions.total    : 0,
    passed:   stats && stats.assertions ? stats.assertions.pending !== undefined
                ? (stats.assertions.total - stats.assertions.failed) : stats.assertions.total - (stats.assertions.failed || 0)
                : 0,
    failed:   stats && stats.assertions ? stats.assertions.failed   : 0,
    duration: timings ? timings.completed - timings.started : 0,
    requests: reqs,
  };
}

const expensesContract = parseNewman(expensesNM, 'Expenses API');

// ── Parse Playwright ──────────────────────────────────────────────────────────

function parsePlaywright(data) {
  if (!data) return { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0, suites: [] };
  const stats = data.stats || {};
  const suites = (data.suites || []).flatMap(s =>
    (s.suites || [s]).map(sub => ({
      title: sub.title || s.title || '',
      specs: (sub.specs || []).map(sp => ({
        title: sp.title,
        status: sp.ok ? 'PASS' : 'FAIL',
        duration: sp.tests && sp.tests[0] ? sp.tests[0].results.reduce((a, r) => a + (r.duration || 0), 0) : 0,
      })),
    }))
  );
  return {
    total:    stats.expected || 0,
    passed:   stats.expected ? stats.expected - (stats.unexpected || 0) - (stats.skipped || 0) : 0,
    failed:   stats.unexpected || 0,
    skipped:  stats.skipped || 0,
    duration: stats.duration || 0,
    suites,
  };
}

const e2eData = parsePlaywright(playwright);

// ── Parse k6 ─────────────────────────────────────────────────────────────────

function parseK6(data) {
  if (!data) return { pass: null, metrics: {}, thresholds: [] };
  const m = data.metrics || {};

  const get = (key, stat) => {
    const entry = m[key];
    if (!entry) return null;
    const v = entry[stat];
    return v != null ? Math.round(v) : null;
  };

  const thresholds = [];
  let anyFailed = false;
  Object.entries(m).forEach(([metricKey, metric]) => {
    if (metric && metric.thresholds) {
      Object.entries(metric.thresholds).forEach(([expr, violated]) => {
        const pass = !violated;
        if (!pass) anyFailed = true;
        thresholds.push({ name: `${metricKey}: ${expr}`, pass });
      });
    }
  });

  return {
    pass: !anyFailed,
    thresholds,
    metrics: {
      vus_max:    get('vus_max', 'max'),
      iterations: get('iterations', 'count'),
      req_total:  get('http_reqs', 'count'),
      req_failed: m.http_req_failed != null ? m.http_req_failed.value : null,
      p95:        get('http_req_duration', 'p(95)'),
      p99:        get('http_req_duration', 'p(99)'),
      avg:        get('http_req_duration', 'avg'),
      median:     get('http_req_duration', 'med'),
    },
  };
}

const k6Data = parseK6(k6);

// ── Parse ZAP ────────────────────────────────────────────────────────────────

function zapRiskLabel(a) {
  const code = parseInt(a.riskcode, 10);
  if (code === 3) return 'High';
  if (code === 2) return 'Medium';
  if (code === 1) return 'Low';
  if (code === 0) return 'Informational';
  const desc = a.riskdesc || a.risk || '';
  return desc.split(/[\s(]/)[0] || 'Info';
}

function parseZAP(data) {
  if (!data) return { pass: null, alerts: [] };
  const site = (data.site || [])[0] || {};
  const alerts = (site.alerts || []).map(a => ({
    risk:     zapRiskLabel(a),
    name:     a.name || a.alert || '',
    solution: a.solution ? a.solution.replace(/<[^>]+>/g, '').trim() : '',
    count:    a.count || (a.instances && a.instances.length) || 0,
  }));
  const high   = alerts.filter(a => a.risk === 'High').length;
  const medium = alerts.filter(a => a.risk === 'Medium').length;
  const low    = alerts.filter(a => a.risk === 'Low').length;
  const info   = alerts.filter(a => !['High','Medium','Low'].includes(a.risk)).length;
  return { pass: high === 0 && medium === 0, high, medium, low, info, alerts };
}

const zapData = parseZAP(zap);

// ── Stage status lookup ───────────────────────────────────────────────────────

function stageStatus(name) {
  const s = (meta.stages || []).find(x => x.name === name);
  return s ? s.status : 'SKIP';
}

function stageDuration(name) {
  const s = (meta.stages || []).find(x => x.name === name);
  return s ? s.durationMs : 0;
}

// ── Totals ────────────────────────────────────────────────────────────────────

const totalTests  = unitData.total + compData.total + e2eData.total;
const totalPassed = unitData.passed + compData.passed + e2eData.passed;
const totalFailed = unitData.failed + compData.failed + e2eData.failed;
const contractTotal  = expensesContract.total;
const contractFailed = expensesContract.failed;
const overall = meta.overallStatus || 'UNKNOWN';
const runAt   = meta.runAt ? new Date(meta.runAt).toLocaleString() : new Date().toLocaleString();

// ── HTML helpers ──────────────────────────────────────────────────────────────

function metricCard(label, value, sub = '') {
  return `<div class="metric-card"><div class="metric-value">${value}</div><div class="metric-label">${label}</div>${sub ? `<div class="metric-sub">${sub}</div>` : ''}</div>`;
}

function jestSection(d, stageKey) {
  const status = stageStatus(stageKey);
  const pct = d.total > 0 ? Math.round((d.passed / d.total) * 100) : 0;
  const rows = d.suites.flatMap(s => s.tests.map(t =>
    `<tr class="${t.status === 'FAIL' ? 'row-fail' : ''}">
       <td class="td-suite">${s.file}</td>
       <td>${escHtml(t.name)}</td>
       <td>${statusBadge(t.status)}</td>
       <td class="td-right">${fmtMs(t.duration)}</td>
     </tr>`
  )).join('');
  return `
  <section class="stage-section">
    <div class="stage-header">
      <h2>${d.label}</h2>
      <div class="stage-meta">
        ${statusBadge(status)}
        <span class="stage-duration">${fmtMs(stageDuration(stageKey))}</span>
      </div>
    </div>
    <div class="stage-metrics">
      ${metricCard('Total', d.total)}
      ${metricCard('Passed', d.passed)}
      ${metricCard('Failed', d.failed)}
      ${metricCard('Pass Rate', `${pct}%`)}
    </div>
    ${rows ? `<table class="data-table"><thead><tr><th>Suite</th><th>Test</th><th>Status</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="no-data">No test data available.</p>'}
  </section>`;
}

function newmanSection(contracts) {
  const status = stageStatus('Contract Tests (Newman)');
  const dur    = stageDuration('Contract Tests (Newman)');
  const total  = contracts.reduce((s, c) => s + c.total, 0);
  const passed = contracts.reduce((s, c) => s + c.passed, 0);
  const failed = contracts.reduce((s, c) => s + c.failed, 0);

  function reqRows(d) {
    return d.requests.map(r => {
      const assertHtml = r.assertions.map(a =>
        `<li class="${a.pass ? 'assert-pass' : 'assert-fail'}">${escHtml(a.name)}</li>`
      ).join('');
      return `<tr class="${!r.pass ? 'row-fail' : ''}">
        <td><span class="method method-${r.method.toLowerCase()}">${r.method}</span></td>
        <td>${escHtml(r.name)}</td>
        <td class="td-right">${r.status}</td>
        <td class="td-right">${fmtMs(r.time)}</td>
        <td>${statusBadge(r.pass ? 'PASS' : 'FAIL')}</td>
        <td><ul class="assert-list">${assertHtml}</ul></td>
      </tr>`;
    }).join('');
  }

  function collectionTable(d) {
    const rows = reqRows(d);
    return rows
      ? `<h3 class="collection-title">${d.label}</h3>
         <table class="data-table">
           <thead><tr><th>Method</th><th>Request</th><th>Status</th><th>Time</th><th>Result</th><th>Assertions</th></tr></thead>
           <tbody>${rows}</tbody>
         </table>`
      : `<h3 class="collection-title">${d.label}</h3><p class="no-data">No data available.</p>`;
  }

  return `
  <section class="stage-section">
    <div class="stage-header">
      <h2>Contract Tests <span class="tool-label">Newman</span></h2>
      <div class="stage-meta">
        ${statusBadge(status)}
        <span class="stage-duration">${fmtMs(dur)}</span>
      </div>
    </div>
    <div class="stage-metrics">
      ${metricCard('Assertions', total)}
      ${metricCard('Passed', passed)}
      ${metricCard('Failed', failed)}
      ${metricCard('Collections', String(contracts.length))}
    </div>
    ${contracts.map(collectionTable).join('')}
  </section>`;
}

function playwrightSection(d) {
  const status = stageStatus('E2E Tests (Playwright)');
  const pct = d.total > 0 ? Math.round((d.passed / d.total) * 100) : 0;
  const rows = d.suites.flatMap(s => (s.specs || []).map(sp =>
    `<tr class="${sp.status === 'FAIL' ? 'row-fail' : ''}">
       <td class="td-suite">${escHtml(s.title)}</td>
       <td>${escHtml(sp.title)}</td>
       <td>${statusBadge(sp.status)}</td>
       <td class="td-right">${fmtMs(sp.duration)}</td>
     </tr>`
  )).join('');
  return `
  <section class="stage-section">
    <div class="stage-header">
      <h2>E2E Tests <span class="tool-label">Playwright</span></h2>
      <div class="stage-meta">
        ${statusBadge(status)}
        <span class="stage-duration">${fmtMs(stageDuration('E2E Tests (Playwright)'))}</span>
      </div>
    </div>
    <div class="stage-metrics">
      ${metricCard('Total', d.total)}
      ${metricCard('Passed', d.passed)}
      ${metricCard('Failed', d.failed)}
      ${metricCard('Skipped', d.skipped)}
      ${metricCard('Pass Rate', `${pct}%`)}
    </div>
    ${rows ? `<table class="data-table"><thead><tr><th>Suite</th><th>Test</th><th>Status</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="no-data">No test data available.</p>'}
  </section>`;
}

function k6Section(d) {
  const status = stageStatus('Performance Tests (k6)');
  const m = d.metrics;
  const thresholdRows = (d.thresholds || []).map(t =>
    `<tr class="${t.pass ? '' : 'row-fail'}"><td>${escHtml(t.name)}</td><td>${statusBadge(t.pass ? 'PASS' : 'FAIL')}</td></tr>`
  ).join('');

  const barData = [
    { label: 'avg',    value: m.avg    || 0 },
    { label: 'median', value: m.median || 0 },
    { label: 'p95',    value: m.p95    || 0 },
    { label: 'p99',    value: m.p99    || 0 },
  ];
  const maxVal = Math.max(...barData.map(b => b.value), 1);
  const bars = barData.map(b => {
    const pct = Math.round((b.value / maxVal) * 100);
    const cls = b.value > 800 ? 'bar-danger' : b.value > 500 ? 'bar-warn' : 'bar-ok';
    return `<div class="perf-bar-row">
      <div class="perf-bar-label">${b.label}</div>
      <div class="perf-bar-track"><div class="perf-bar ${cls}" style="width:${pct}%"></div></div>
      <div class="perf-bar-value">${b.value}ms</div>
    </div>`;
  }).join('');

  return `
  <section class="stage-section">
    <div class="stage-header">
      <h2>Performance Tests <span class="tool-label">k6</span></h2>
      <div class="stage-meta">
        ${statusBadge(status)}
        <span class="stage-duration">${fmtMs(stageDuration('Performance Tests (k6)'))}</span>
      </div>
    </div>
    <div class="stage-metrics">
      ${metricCard('Max VUs',   fmtNum(m.vus_max))}
      ${metricCard('Requests',  fmtNum(m.req_total))}
      ${metricCard('p95 Latency', m.p95 != null ? `${m.p95}ms` : '—')}
      ${metricCard('Error Rate', m.req_failed != null ? `${(m.req_failed * 100).toFixed(2)}%` : '—')}
    </div>
    <div class="perf-layout">
      <div class="perf-chart">
        <h3>Response Time Distribution</h3>
        ${bars}
      </div>
      ${thresholdRows ? `<div class="perf-thresholds">
        <h3>Thresholds</h3>
        <table class="data-table"><thead><tr><th>Threshold</th><th>Result</th></tr></thead><tbody>${thresholdRows}</tbody></table>
      </div>` : ''}
    </div>
  </section>`;
}

function zapSection(d) {
  const status = stageStatus('Security Scan (OWASP ZAP)');

  function riskClass(risk) {
    if (risk === 'High')   return 'risk-high';
    if (risk === 'Medium') return 'risk-medium';
    if (risk === 'Low')    return 'risk-low';
    return 'risk-info';
  }

  const rows = (d.alerts || []).map(a => `
    <tr>
      <td><span class="risk-badge ${riskClass(a.risk)}">${a.risk.replace(/\s*\(\d+\)/, '')}</span></td>
      <td>${escHtml(a.name)}</td>
      <td class="td-right">${a.count}</td>
      <td class="td-desc">${escHtml(a.solution.slice(0, 120))}${a.solution.length > 120 ? '…' : ''}</td>
    </tr>`).join('');

  return `
  <section class="stage-section">
    <div class="stage-header">
      <h2>Security Scan <span class="tool-label">OWASP ZAP</span></h2>
      <div class="stage-meta">
        ${statusBadge(status)}
        <span class="stage-duration">${fmtMs(stageDuration('Security Scan (OWASP ZAP)'))}</span>
      </div>
    </div>
    <div class="stage-metrics">
      ${metricCard('High',   d.high   != null ? String(d.high)   : '—')}
      ${metricCard('Medium', d.medium != null ? String(d.medium) : '—')}
      ${metricCard('Low',    d.low    != null ? String(d.low)    : '—')}
      ${metricCard('Info',   d.info   != null ? String(d.info)   : '—')}
    </div>
    ${rows ? `<table class="data-table">
      <thead><tr><th>Risk</th><th>Alert</th><th>Count</th><th>Remedy</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : '<p class="no-data">No alert data available.</p>'}
  </section>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function summaryTable() {
  const stages = meta.stages || [];
  if (!stages.length) return '';
  const rows = stages.map(s => `
    <tr>
      <td>${escHtml(s.name)}</td>
      <td>${statusBadge(s.status)}</td>
      <td class="td-right">${fmtMs(s.durationMs)}</td>
    </tr>`).join('');
  return `
  <section class="stage-section summary-table-section">
    <div class="stage-header"><h2>Pipeline Summary</h2></div>
    <table class="data-table summary-tbl">
      <thead><tr><th>Stage</th><th>Result</th><th>Duration</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

// ── Assemble HTML ─────────────────────────────────────────────────────────────

const overallClass = overall === 'PASS' ? 'overall-pass' : overall === 'FAIL' ? 'overall-fail' : 'overall-unknown';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pipeline Report — Expense Tracker — ${runAt}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:15px}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f1117;color:#c9d1d9;line-height:1.6}
a{color:#58a6ff}
h2{font-size:1.15rem;font-weight:600;color:#e6edf3}
h3{font-size:.95rem;font-weight:600;color:#8b949e;margin:1rem 0 .5rem}
.page{max-width:1200px;margin:0 auto;padding:0 1.5rem 3rem}
.hero{padding:2.5rem 0 2rem;display:flex;flex-direction:column;gap:.75rem}
.hero-top{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.hero-title{font-size:1.6rem;font-weight:700;color:#e6edf3;letter-spacing:-.02em}
.hero-sub{color:#8b949e;font-size:.9rem}
.overall-badge{display:inline-flex;align-items:center;gap:.4rem;padding:.35rem .9rem;border-radius:6px;font-weight:700;font-size:.9rem;letter-spacing:.04em}
.overall-pass{background:#0d4c2a;color:#3fb950;border:1px solid #2ea043}
.overall-fail{background:#4c1015;color:#f85149;border:1px solid #f85149}
.overall-unknown{background:#2d2f33;color:#8b949e;border:1px solid #444}
.hero-meta{font-size:.82rem;color:#8b949e;display:flex;gap:1.5rem;flex-wrap:wrap}
.global-metrics{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
.metric-card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:.9rem 1.2rem;min-width:110px;text-align:center}
.metric-value{font-size:1.5rem;font-weight:700;color:#e6edf3}
.metric-label{font-size:.75rem;color:#8b949e;text-transform:uppercase;letter-spacing:.06em;margin-top:.15rem}
.metric-sub{font-size:.75rem;color:#8b949e;margin-top:.1rem}
.stage-section{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:1.5rem;margin-bottom:1.5rem}
.stage-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem}
.stage-header h2{margin:0}
.stage-meta{display:flex;align-items:center;gap:.75rem}
.stage-duration{font-size:.82rem;color:#8b949e}
.tool-label{font-size:.7rem;background:#21262d;color:#8b949e;border-radius:4px;padding:.1rem .5rem;margin-left:.4rem;vertical-align:middle}
.stage-metrics{display:flex;gap:.75rem;margin-bottom:1.25rem;flex-wrap:wrap}
.stage-metrics .metric-card{min-width:80px;padding:.65rem .9rem}
.stage-metrics .metric-value{font-size:1.2rem}
.summary-table-section{border-color:#30363d}
.badge{display:inline-block;padding:.15rem .55rem;border-radius:4px;font-size:.72rem;font-weight:700;letter-spacing:.05em}
.badge-pass{background:#0d4c2a;color:#3fb950}
.badge-fail{background:#4c1015;color:#f85149}
.badge-skip{background:#2d2f33;color:#8b949e}
.data-table{width:100%;border-collapse:collapse;font-size:.83rem;margin-top:.5rem}
.data-table th{background:#0d1117;color:#8b949e;font-weight:600;text-transform:uppercase;font-size:.72rem;letter-spacing:.05em;padding:.55rem .75rem;text-align:left;border-bottom:1px solid #21262d}
.data-table td{padding:.5rem .75rem;border-bottom:1px solid #161b22;vertical-align:top}
.data-table tr:last-child td{border-bottom:none}
.data-table tr.row-fail td{background:rgba(248,81,73,.06)}
.data-table tr:hover td{background:#1c2129}
.td-suite{color:#8b949e;font-size:.78rem;max-width:180px;word-break:break-all}
.td-right{text-align:right;white-space:nowrap}
.td-desc{font-size:.78rem;color:#8b949e;max-width:260px}
.no-data{color:#8b949e;font-size:.85rem;padding:.5rem 0}
.collection-title{margin-top:1.25rem;color:#8b949e;font-size:.9rem}
.method{display:inline-block;padding:.1rem .45rem;border-radius:3px;font-size:.7rem;font-weight:700}
.method-get{background:#0d2f5c;color:#58a6ff}
.method-post{background:#0d4c2a;color:#3fb950}
.method-put{background:#3d2600;color:#d29922}
.method-delete{background:#4c1015;color:#f85149}
.method-patch{background:#2d0a4e;color:#a371f7}
.assert-list{list-style:none;font-size:.75rem;line-height:1.8}
.assert-pass::before{content:"✓ ";color:#3fb950}
.assert-fail::before{content:"✗ ";color:#f85149}
.perf-layout{display:flex;gap:1.5rem;flex-wrap:wrap;align-items:flex-start}
.perf-chart{flex:1;min-width:280px}
.perf-thresholds{flex:0 0 320px}
.perf-bar-row{display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem}
.perf-bar-label{width:52px;font-size:.78rem;color:#8b949e;text-align:right}
.perf-bar-track{flex:1;background:#21262d;border-radius:4px;height:16px;overflow:hidden}
.perf-bar{height:100%;border-radius:4px;transition:width .3s}
.bar-ok{background:#1f6feb}
.bar-warn{background:#d29922}
.bar-danger{background:#f85149}
.perf-bar-value{width:64px;font-size:.78rem;color:#c9d1d9;text-align:right}
.risk-badge{display:inline-block;padding:.15rem .55rem;border-radius:4px;font-size:.72rem;font-weight:700;white-space:nowrap}
.risk-high{background:#4c1015;color:#f85149}
.risk-medium{background:#3d2600;color:#d29922}
.risk-low{background:#0d2f5c;color:#58a6ff}
.risk-info{background:#2d2f33;color:#8b949e}
.divider{border:none;border-top:1px solid #21262d;margin:2rem 0}
</style>
</head>
<body>
<div class="page">

  <header class="hero">
    <div class="hero-top">
      <h1 class="hero-title">CI/CD Pipeline Report — Expense Tracker</h1>
      <span class="overall-badge ${overallClass}">${overall === 'PASS' ? '✓ PASSED' : overall === 'FAIL' ? '✗ FAILED' : overall}</span>
    </div>
    <div class="hero-meta">
      <span>Run: <strong>${escHtml(runAt)}</strong></span>
      <span>Duration: <strong>${fmtMs(meta.durationMs)}</strong></span>
      <span>Stages: <strong>${(meta.stages || []).length}</strong></span>
    </div>
  </header>

  <div class="global-metrics">
    ${metricCard('Tests Run',    totalTests)}
    ${metricCard('Passed',       totalPassed)}
    ${metricCard('Failed',       totalFailed)}
    ${metricCard('API Assertions', contractTotal)}
    ${metricCard('API Failures', contractFailed)}
    ${metricCard('k6 p95',       k6Data.metrics.p95 != null ? `${k6Data.metrics.p95}ms` : '—')}
    ${metricCard('ZAP High',     zapData.high != null ? String(zapData.high) : '—')}
    ${metricCard('ZAP Medium',   zapData.medium != null ? String(zapData.medium) : '—')}
  </div>

  ${summaryTable()}

  <hr class="divider">

  ${jestSection(unitData, 'Unit Tests')}
  ${jestSection(compData, 'Component Tests')}
  ${newmanSection([expensesContract])}
  ${playwrightSection(e2eData)}
  ${k6Section(k6Data)}
  ${zapSection(zapData)}

</div>
</body>
</html>`;

fs.writeFileSync(OUT_FILE, html);
console.log(`Report written → ${OUT_FILE}`);

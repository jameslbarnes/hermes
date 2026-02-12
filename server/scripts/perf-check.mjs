const BASE_URL = process.env.PERF_BASE_URL || 'https://hermes.teleport.computer';
const RUNS = parseInt(process.env.PERF_RUNS || '7', 10);

const BUDGET_HOME_P50_MS = parseInt(process.env.BUDGET_HOME_P50_MS || '120', 10);
const BUDGET_API_P50_MS = parseInt(process.env.BUDGET_API_P50_MS || '320', 10);
const BUDGET_DEEP_CURSOR_P50_MS = parseInt(process.env.BUDGET_DEEP_CURSOR_P50_MS || '320', 10);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeMs(fn) {
  const start = performance.now();
  await fn();
  return Number((performance.now() - start).toFixed(1));
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function benchmark(label, fn, runs = RUNS) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    samples.push(await timeMs(fn));
  }
  const p50 = median(samples);
  const avg = Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(1));
  return { label, p50, avg, min: Math.min(...samples), max: Math.max(...samples), runs };
}

async function main() {
  console.log(`Perf target: ${BASE_URL}`);

  const page1 = await fetchJson(`${BASE_URL}/api/entries?limit=30`);
  if (!page1.nextCursor) {
    throw new Error('Expected nextCursor in /api/entries response but it was missing');
  }

  let cursor = page1.nextCursor;
  for (let i = 0; i < 9 && cursor; i += 1) {
    const page = await fetchJson(`${BASE_URL}/api/entries?limit=30&cursor=${encodeURIComponent(cursor)}`);
    cursor = page.nextCursor;
  }

  if (!cursor) {
    throw new Error('Could not reach deep cursor page; dataset too small or cursor flow broken');
  }

  const deepCursorUrl = `${BASE_URL}/api/entries?limit=30&cursor=${encodeURIComponent(cursor)}`;

  const results = [];
  results.push(await benchmark('home', async () => {
    const res = await fetch(`${BASE_URL}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for /`);
  }));

  results.push(await benchmark('api_page1', async () => {
    await fetchJson(`${BASE_URL}/api/entries?limit=30`);
  }));

  results.push(await benchmark('api_deep_cursor', async () => {
    await fetchJson(deepCursorUrl);
  }));

  console.table(results);

  const failures = [];
  const home = results.find(r => r.label === 'home');
  const api = results.find(r => r.label === 'api_page1');
  const deep = results.find(r => r.label === 'api_deep_cursor');

  if (home && home.p50 > BUDGET_HOME_P50_MS) failures.push(`home p50 ${home.p50}ms > ${BUDGET_HOME_P50_MS}ms`);
  if (api && api.p50 > BUDGET_API_P50_MS) failures.push(`api_page1 p50 ${api.p50}ms > ${BUDGET_API_P50_MS}ms`);
  if (deep && deep.p50 > BUDGET_DEEP_CURSOR_P50_MS) failures.push(`api_deep_cursor p50 ${deep.p50}ms > ${BUDGET_DEEP_CURSOR_P50_MS}ms`);

  if (failures.length > 0) {
    console.error('Perf budget failures:');
    for (const fail of failures) console.error(`- ${fail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

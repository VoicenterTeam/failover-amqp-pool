// #65: the rabbitmq.test.js leak guard finds this run's leftovers however many queues the broker
// holds. The guard runs against a fake management API that pages and filters as RabbitMQ 3.13
// and 4.3 do: page_size at most 500, `name` a case-insensitive substring filter.
const { test } = require('node:test');
const assert = require('node:assert');
const { leftovers } = require('./helpers/leak-guard');

const pid = 4242;
const since = 1700000000000;
const ours = `famqp-test-${pid}-${since + 5}-a1`;

function fakeApi(names) {
  const paths = [];
  const get = async path => {
    paths.push(path);
    const [kind, query] = path.split('/%2F?');
    const q = new URLSearchParams(query);
    const size = Number(q.get('page_size')), page = Number(q.get('page'));
    if (!(size >= 1 && size <= 500)) throw new Error(`400 page size ${size}`);
    const filter = (q.get('name') || '').toLowerCase();
    const all = (names[kind] || []).filter(n => n.toLowerCase().includes(filter));
    const pageCount = Math.ceil(all.length / size);
    if (page < 1 || page > Math.max(pageCount, 1)) throw new Error(`400 page ${page}`);
    const items = all.slice((page - 1) * size, page * size).map(name => ({ name }));
    return { items, page, page_count: pageCount, page_size: size, filtered_count: all.length };
  };
  return { get, paths };
}

const many = (n, name) => Array.from({ length: n }, (_, i) => name(i));

test('#65 a leak after 600 queues of other apps is caught, on one page a kind', async () => {
  const { get, paths } = fakeApi({ queues: [...many(600, i => `app-q-${i}`), ours] });
  assert.deepStrictEqual(await leftovers(get, { pid, since }), [`queues:${ours}`]);
  assert.strictEqual(paths.length, 2, 'the name filter leaves one page per kind');
});

test('#65 a leaked queue listed after 600 famqp- queues of other runs is caught', async () => {
  const others = many(600, i => `famqp-test-${pid + 1}-${since + i}-z`);
  const { get } = fakeApi({ queues: [...others, ours] });
  assert.deepStrictEqual(await leftovers(get, { pid, since }), [`queues:${ours}`]);
});

test('#65 only names carrying this pid and a time from this run count', async () => {
  const rows = {
    'this run': [ours, true],
    'this run, an exchange': [`famqp-ex-${pid}-${since}`, true],
    'same pid, an older run': [`famqp-test-${pid}-${since - 1}-b2`, false],
    'pid as the tail of a longer one': [`famqp-test-1${pid}-${since + 1}-c3`, false],
    'famqp- inside the name, not at its start': [`x-famqp-test-${pid}-${since + 1}`, false],
  };
  const exchange = rows['this run, an exchange'][0];
  const queues = Object.values(rows).map(([name]) => name).filter(n => n !== exchange);
  const { get } = fakeApi({ queues, exchanges: [exchange] });
  const left = await leftovers(get, { pid, since });
  for (const [row, [name, caught]] of Object.entries(rows)) {
    assert.strictEqual(left.some(l => l.endsWith(`:${name}`)), caught, row);
  }
});

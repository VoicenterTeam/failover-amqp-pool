// #98: with `accounts`, the #65 guard also lists the famqp- vhosts and users this run left. They
// carry -<pid>-<ms> like the queues; a vhost may start with '%' (the #9 vhost row's '%famqp-').
const { test } = require('node:test');
const assert = require('node:assert');
const { leftovers } = require('./helpers/leak-guard');

const pid = 4242;
const since = 1700000000000;

// a management API holding the given vhosts and users, and no queue or exchange
function fakeApi({ vhosts = [], users = [] }) {
  const paths = [];
  const get = async path => {
    paths.push(path);
    if (path.startsWith('vhosts?')) return vhosts.map(name => ({ name }));
    if (path.startsWith('users?')) return users.map(name => ({ name }));
    return { items: [], page: 1, page_count: 0 };
  };
  return { get, paths };
}

test('#98 vhosts and users this run left are listed', async () => {
  const rows = {
    'a vhost of this run': ['vhosts', `famqp-prod-${pid}-${since}`, true],
    "a vhost of this run starting with '%'": ['vhosts', `%famqp-pct-${pid}-${since + 1}`, true],
    'a user of this run': ['users', `famqp-i9-${pid}-${since}-0`, true],
    'a vhost of an older run, same pid': ['vhosts', `famqp-prod-${pid}-${since - 1}`, false],
    'a user of another pid': ['users', `famqp-i9-${pid + 1}-${since}-0`, false],
    'a vhost with famqp- deeper in its name': ['vhosts', `x-famqp-prod-${pid}-${since}`, false],
    'the default vhost and an app user': ['users', 'rig', false],
  };
  const names = { vhosts: [], users: [] };
  for (const [kind, name] of Object.values(rows)) names[kind].push(name);
  const left = await leftovers(fakeApi(names).get, { pid, since, accounts: true });
  for (const [row, [kind, name, caught]] of Object.entries(rows)) {
    assert.strictEqual(left.includes(`${kind}:${name}`), caught, row);
  }
});

test('#98 without accounts the guard reads no vhost or user', async () => {
  const { get, paths } = fakeApi({ vhosts: [`famqp-prod-${pid}-${since}`] });
  assert.deepStrictEqual(await leftovers(get, { pid, since }), []);
  assert.deepStrictEqual(paths.filter(p => /^(vhosts|users)\?/.test(p)), []);
});

// The file-level leak guard of rabbitmq.test.js: the queues and exchanges this process declared
// that are still on the broker. get(path) reads one management API path and returns its JSON.
async function leftovers(get, { pid }) {
  const mine = `-${pid}-`;
  const left = [];
  for (const kind of ['queues', 'exchanges']) {
    for (const x of (await get(`${kind}/%2F?columns=name&page=1&page_size=500`)).items) {
      if (x.name.startsWith('famqp-') && x.name.includes(mine)) left.push(`${kind}:${x.name}`);
    }
  }
  return left;
}

module.exports = { leftovers };

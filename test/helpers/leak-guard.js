// The file-level leak guard of rabbitmq.test.js: the queues and exchanges this run declared that
// are still on the broker. get(path) reads one management API path and returns its JSON.
// The API returns at most 500 names a page, so the guard asks only for famqp- names and reads
// every page. A name is this run's when it carries `-<pid>-<ms>` with ms at or after `since`,
// the run's start: a leftover from an older process with the same pid does not count.
const PAGE_SIZE = 500;

const isOurs = (name, pid, since) => {
  const stamp = name.startsWith('famqp-') && name.match(new RegExp(`-${pid}-(\\d+)`));
  return Boolean(stamp) && Number(stamp[1]) >= since;
};

async function leftovers(get, { pid, since }) {
  const left = [];
  for (const kind of ['queues', 'exchanges']) {
    for (let page = 1, pages = 1; page <= pages; page++) {
      const query = `columns=name&name=famqp-&page=${page}&page_size=${PAGE_SIZE}`;
      const res = await get(`${kind}/%2F?${query}`);
      pages = res.page_count;
      for (const { name } of res.items) if (isOurs(name, pid, since)) left.push(`${kind}:${name}`);
    }
  }
  return left;
}

module.exports = { leftovers };

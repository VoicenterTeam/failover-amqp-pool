// The management API as the live rows read it: one queue's flags and arguments, one connection.
const MGMT = process.env.FAMQP_TEST_MGMT_URL;

async function mgmt(method, path) {
  const m = new URL(MGMT);
  const login = `${decodeURIComponent(m.username)}:${decodeURIComponent(m.password)}`;
  const headers = { authorization: `Basic ${Buffer.from(login).toString('base64')}` };
  const res = await fetch(`${m.origin}/api/${path}`, { method, headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return method === 'GET' ? res.json() : undefined;
}

// polls (a pinned number of reads) until read() returns something truthy
async function until(read, what, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const value = await read();
    if (value) return value;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`gave up waiting for ${what}`);
}

const queuePath = name => `queues/%2F/${encodeURIComponent(name)}`;
const queueInfo = name =>
  until(() => mgmt('GET', queuePath(name)), `queue ${name} in the management API`);
const connectionNamed = name => until(async () => {
  const all = await mgmt('GET', 'connections');
  return all.find(c => c.client_properties?.connection_name === name);
}, `connection ${name}`);
const closeConnection = c => mgmt('DELETE', `connections/${encodeURIComponent(c.name)}`);

module.exports = { MGMT, mgmt, until, queuePath, queueInfo, connectionNamed, closeConnection };

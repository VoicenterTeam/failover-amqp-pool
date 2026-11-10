// Pools whose connections never dial out, so a test owns their state. Stubbed once per test:
// a second stub would save the first as the original and never restore it.
const Connection = require('../../Connection');

const realStart = Connection.prototype.start;

function offline(t) {
  Connection.prototype.start = function () {};
  t.after(() => { Connection.prototype.start = realStart; });
}

module.exports = { offline };

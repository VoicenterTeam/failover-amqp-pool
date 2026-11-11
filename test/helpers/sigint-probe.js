// Preloaded with --require into a test file run on its own: records the process's SIGINT
// listener count when the file starts, the highest it reaches, and the count at exit, as one
// JSON record in the file LANE_D_SIGINT_OUT names.
const fs = require('node:fs');

const out = process.env.LANE_D_SIGINT_OUT;
const before = process.listenerCount('SIGINT');
let peak = before;
process.on('newListener', event => {
  if (event === 'SIGINT') peak = Math.max(peak, process.listenerCount('SIGINT') + 1);
});
process.on('exit', () => {
  const after = process.listenerCount('SIGINT');
  fs.writeFileSync(out, JSON.stringify({ before, peak, after }));
});

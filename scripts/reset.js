'use strict';
// Deletes the locally persisted demo state. The next `npm start` re-seeds the original fixture.
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.CLAIMTRAIL_DATA || path.join(__dirname, '..', 'data', 'state.json');
for (const f of [file, file + '.tmp']) {
  try { fs.rmSync(f); console.log(`Deleted ${f}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
console.log('Demo data cleared. Start the app to restore the original fictional fixture.');

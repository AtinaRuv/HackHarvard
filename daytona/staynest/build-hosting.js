const fs = require('node:fs');
const path = require('node:path');
const { makeWorkerSource } = require('./hosting');

// Deployment-only output; the Daytona backend does not need this build step.
function buildHosting(output) {
  if (!output) throw new Error('Provide the output Worker filename.');
  const files = {};
  for (const variant of ['legitimate', 'malicious']) {
    files['/' + variant] = { type: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, 'public', variant + '.html'), 'utf8') };
  }
  for (const name of ['living', 'kitchen', 'bedroom', 'kitchen-front', 'kitchen-side']) {
    // JPEG packaging copies keep the Worker small; original PNGs are preserved.
    // Keep the existing image URLs, with the correct JPEG response MIME type.
    files['/assets/' + name + '.png'] = { type: 'image/jpeg', base64: true,
      body: fs.readFileSync(path.join(__dirname, 'hosting-images', name + '.jpg')).toString('base64') };
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, makeWorkerSource(files));
  console.log('Built header-controlled demo Worker:', fs.statSync(output).size, 'bytes');
}
if (require.main === module) buildHosting(process.argv[2]);
module.exports = { buildHosting };

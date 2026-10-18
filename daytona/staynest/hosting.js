// Header-controlled demo hosting. No backend credentials or outbound requests.
function serveDemo(request, files) {
  const url = new URL(request.url);
  const headers = { 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' };
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers });
  let name = url.pathname;
  if (name === '/' || name === '/index.html') name = '/legitimate';
  if (name === '/legitimate.html' || name === '/malicious.html') name = name.slice(0, -5);
  if (url.search || !Object.hasOwn(files, name)) return new Response(null, { status: 404, headers });
  const file = files[name];
  headers['content-type'] = file.type;
  const body = request.method === 'HEAD' ? null : file.base64
    ? Uint8Array.from(atob(file.body), character => character.charCodeAt(0)) : file.body;
  return new Response(body, { headers });
}

function makeWorkerSource(files) {
  return `const files = ${JSON.stringify(files)};\nconst serveDemo = ${serveDemo.toString()};\nexport default { fetch(request) { return serveDemo(request, files); } };\n`;
}
module.exports = { serveDemo, makeWorkerSource };

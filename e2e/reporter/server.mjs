// Mock API for the reporter checks: /delay/<ms> answers 200 after that long, /status/<code> at once.
import * as http from 'node:http';

const port = Number(process.env.PLP_E2E_PORT || 4180);
http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://x');
  req.resume();
  const [, kind, arg] = pathname.split('/');
  const reply = (status) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: pathname, status }));
  };
  if (kind === 'delay') setTimeout(() => reply(200), Number(arg));
  else if (kind === 'status') reply(Number(arg));
  else if (pathname === '/') reply(200);
  else reply(404);
}).listen(port, '127.0.0.1');

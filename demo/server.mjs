// Mock shop API for `npm run demo`: two listeners (the API and a CDN), each route answers after
// the delay it is named for, so the request lines show believable timings.
import * as http from 'node:http';

const API_PORT = Number(process.env.PLP_DEMO_API_PORT || 4310);
const CDN_PORT = Number(process.env.PLP_DEMO_CDN_PORT || 4311);

// The real round trip adds a few milliseconds on top of these.
const ROUTES = [
  ['GET', '/v1/products', 200, 136, [{ id: 1, name: 'Kettle' }]],
  ['POST', '/v1/cart/items', 201, 82, { id: 42 }],
  ['PUT', '/v1/cart/items/42', 200, 91, { id: 42, qty: 2 }],
  ['PATCH', '/v1/users/7', 204, 55, undefined],
  ['DELETE', '/v1/sessions/old', 204, 39, undefined],
  ['GET', '/v1/orders/99999', 404, 67, { error: 'order not found' }],
  ['POST', '/v1/checkout', 500, 1824, { error: 'payment gateway timeout' }],
  ['GET', '/assets/catalog.json', 304, 6, undefined],
];

function listen(port) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    const route = ROUTES.find(([method, path]) => method === req.method && path === pathname);
    req.resume();
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const [, , status, delay, body] = route;
    setTimeout(() => {
      if (body === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }, delay);
  });
  server.listen(port, '127.0.0.1');
}

listen(API_PORT);
listen(CDN_PORT);

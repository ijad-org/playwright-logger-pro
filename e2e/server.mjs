// Zero-dependency static server for the e2e suite.
import http from 'node:http';

const PORT = Number(process.env.PLP_E2E_PORT || 4173);

const page = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}<script>${script}</script></body></html>`;

const routes = {
  '/': () => page('Home', `
    <h1>Home</h1>
    <a id="to-login" href="/login">Log in</a>
    <button id="go">Go</button>
    <ul id="list"><li>one</li><li>two</li><li>three</li></ul>
    <input id="text" placeholder="Type here"><input id="chk" type="checkbox" aria-label="Agree">
    <select id="sel"><option value="a">A</option><option value="b">B</option></select>
    <div id="out"></div>`,
  `document.getElementById('go').onclick = () => { document.getElementById('out').textContent = 'went'; };`),

  '/login': () => page('Login', `
    <h1>Sign in</h1>
    <form id="form">
      <label>Email <input id="email" name="email" type="text"></label>
      <label>Password <input id="password" name="password" type="password"></label>
      <label>Verification <input id="field7" name="f7" type="password"></label>
      <label>Nickname <input id="nick" name="nick" type="text"></label>
      <button type="submit">Sign in</button>
    </form>
    <div id="result"></div>`,
  `document.getElementById('form').onsubmit = async (e) => {
     e.preventDefault();
     const r = await fetch('/api/session', { method: 'POST' });
     document.getElementById('result').textContent = 'status ' + r.status;
   };`),

  '/frames': () => page('Frames', '<h1>Frames</h1><iframe id="f" name="inner" src="/frame-inner" width="400" height="200"></iframe>'),
  '/frame-inner': () => page('Inner', '<label>Card <input id="card" type="text"></label><button id="inner-btn">Inner</button>'),

  '/popup': () => page('Popup', '<button id="open" onclick="window.open(\'/popup-child\')">Open</button>'),
  '/popup-child': () => page('Child', '<h1>Child</h1>'),

  '/console': () => page('Console', '<h1>Console</h1>', `
    console.log('plain log'); console.info('info msg'); console.warn('warn msg'); console.error('error msg');
    setTimeout(() => { throw new Error('boom from page'); }, 50);`),

  '/dialog': () => page('Dialog', `
    <button id="alert" onclick="alert('hello alert'); document.getElementById('o').textContent='after alert'">Alert</button>
    <button id="prompt" onclick="document.getElementById('o').textContent = String(prompt('Your PIN?'))">Prompt</button>
    <div id="o"></div>`),

  '/download': () => page('Download', '<a id="dl" href="/file.txt" download="report.txt">Download</a>'),
  '/hang': () => page('Hang', '<button id="never">never</button>'),
  '/hash': () => page('Hash', '<h1>Hash</h1>'),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/session') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad credentials' }));
    return;
  }
  if (url.pathname === '/api/ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echo: url.search }));
    return;
  }
  if (url.pathname === '/api/echo-headers') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === '/file.txt') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' });
    res.end('report body');
    return;
  }
  const route = routes[url.pathname];
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(route());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`e2e server on http://127.0.0.1:${PORT}`);
});

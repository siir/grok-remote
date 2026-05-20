// Tiny shared helpers for the system routes.

export function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function readJsonBody(req, limitBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (b) => {
      total += b.length;
      if (total > limitBytes) {
        req.destroy(new Error('body too large'));
        return;
      }
      chunks.push(b);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.length) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error(`invalid json body: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

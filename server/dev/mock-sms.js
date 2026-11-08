// Stand-in for Twilio Verify (tests only): every code is 123456; a number ending in 9999 can't receive SMS.
import http from 'node:http';
const sent = new Map();
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = new URLSearchParams(body);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!/^Basic /.test(req.headers.authorization || '')) return send(401, { code: 20003 });
    if (/\/Verifications$/.test(req.url)) {
      if (String(p.get('To')).endsWith('9999')) return send(400, { code: 60205, message: 'SMS is not supported by landline phone number' });
      sent.set(p.get('To'), '123456');
      return send(201, { status: 'pending', to: p.get('To') });
    }
    if (/\/VerificationCheck$/.test(req.url)) {
      const ok = sent.get(p.get('To')) === p.get('Code');
      if (ok) sent.delete(p.get('To'));
      return send(200, { status: ok ? 'approved' : 'pending' });
    }
    send(404, {});
  });
}).listen(Number(process.env.MOCK_SMS_PORT || 8097), '127.0.0.1', () => console.log('mock SMS on 8097'));

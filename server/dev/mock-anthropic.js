// Stand-in for the Anthropic Messages API (tests only): answers with JSON that fits the requested schema.
// Records what it was sent so tests can check prompts (e.g. that email text is marked as untrusted data).
import http from 'node:http';

const PORT = Number(process.env.MOCK_ANTHROPIC_PORT || 8096);
const seen = [];
const answer = (props, user) => {
  if (props.summary) return { summary: 'Daniel confirms the Elm Street site visit on Thursday at 9:30.', actionItems: ['Be at 412 Elm St on Thursday 9:30'], needsReply: true };
  if (props.replies) return { replies: [{ label: 'Confirm', text: 'Thursday at 9:30 works. See you there.\n\nMaya' }, { label: 'Ask to move', text: 'Could we do 10:30 instead?\n\nMaya' }, { label: 'Ask a question', text: 'Should I bring anything?\n\nMaya' }] };
  if (props.contactSupport) return /refund|charged/i.test(user) ? { answer: 'Our team will look at billing questions for you.', articles: [], contactSupport: true } : { answer: 'Open Settings → Mail tools → Automatic replies, pick your dates and write your reply.', articles: ['out-of-office', 'not-a-real-slug'], contactSupport: false };
  if (props.needsReply) { const id = Number((/<email id="(\d+)"[^>]*subject="[^"]*(?:question|\?)/i.exec(user) || [])[1]); return { needsReply: id ? [{ id, reason: 'Asking when you are free' }] : [] }; }
  return {};
};
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.url === '/__seen') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(seen.slice(-20))); }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end(); }
    const body = JSON.parse(b || '{}');
    if (req.headers['x-api-key'] !== 'sk-ant-test' && req.headers.authorization !== 'Bearer sk-ant-test') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
    const user = String(body.messages?.[0]?.content || '');
    seen.push({ model: body.model, system: body.system, user, effort: body.output_config?.effort, fallbacks: body.fallbacks, beta: req.headers['anthropic-beta'] });
    if (/REFUSE-ME/.test(user)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_r', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'declined' }, usage: { input_tokens: 10, output_tokens: 0 } })); }
    const out = answer(body.output_config?.format?.schema?.properties || {}, user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } }));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock anthropic on ${PORT}`));

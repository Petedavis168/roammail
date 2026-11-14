// Sign-up verification codes sent through our own AWS number: one code per request, 10 minutes, 5 tries,
// never stored in plain text, not re-sendable within 30 seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendCode, checkCode, setSmsSender } from '../src/phone.js';

test('verification codes by text', async () => {
  const sent = [];
  setSmsSender(async (to, body) => { sent.push({ to, body }); });
  const phone = `+1555${String(Date.now()).slice(-7)}`;
  await sendCode(phone);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, phone);
  assert.match(sent[0].body, /code: \d{6}\. It expires in 10 minutes/);
  const code = sent[0].body.match(/\d{6}/)[0];
  await assert.rejects(sendCode(phone), /just sent a code/, 'no re-send within 30 seconds');
  assert.equal(await checkCode(phone, '000000'), false);
  assert.equal(await checkCode(phone, code), true);
  assert.equal(await checkCode(phone, code), false, 'a code works once');

  // five wrong tries and the code is gone
  const phone2 = `+1556${String(Date.now()).slice(-7)}`;
  await sendCode(phone2);
  const code2 = sent[1].body.match(/\d{6}/)[0];
  for (let i = 0; i < 5; i++) assert.equal(await checkCode(phone2, '111111'), false);
  assert.equal(await checkCode(phone2, code2), false);

  // a landline / invalid number is a clear message
  setSmsSender(async () => { const e = new Error('Destination invalid'); e.name = 'ValidationException'; throw e; });
  await assert.rejects(sendCode(`+1557${String(Date.now()).slice(-7)}`), /can't receive text messages/);
});

// Tests: finish first-sign-in setup the way a person would (new password if the old one was temporary,
// postpone 2-step verification where allowed), so feature tests can use the inbox afterwards.
export const NEW_PW_SUFFIX = 'Qz';
export async function finishSetup(call, data, currentPassword) {
  const steps = data?.setupRequired || [];
  if (!steps.length) return currentPassword;
  let pw = currentPassword;
  if (steps.includes('password')) {
    pw = `${currentPassword}${NEW_PW_SUFFIX}`;
    const r = await call('POST', '/api/setup/password', { password: pw });
    if (r.status !== 200) throw new Error(`setup/password ${r.status} ${JSON.stringify(r.data)}`);
  }
  if (steps.includes('2fa')) await call('POST', '/api/setup/2fa/remind', {}); // 403 for admins: they enable 2FA in the test
  await call('POST', '/api/setup/step', { step: 'done' });
  return pw;
}

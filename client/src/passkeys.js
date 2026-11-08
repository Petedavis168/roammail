// Passkeys (Face ID, fingerprint, Windows Hello, security keys) via the browser's WebAuthn API.
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api } from './api.js';

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Sign in: the device offers the passkeys it holds for roammail.net. Returns the same answer as a password sign-in. */
export async function signInWithPasskey(remember) {
  const { options, token } = await api.post('/api/login/passkey/options', {});
  let response;
  try { response = await startAuthentication({ optionsJSON: options }); }
  catch (e) { throw new Error(e?.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled.' : "Your device couldn't use a passkey."); }
  return api.post('/api/login/passkey', { token, response, remember });
}

/** Add a passkey for this device (needs the current password once). */
export async function addPasskey(password, name) {
  const { options, token } = await api.post('/api/passkeys/register/options', { password });
  let response;
  try { response = await startRegistration({ optionsJSON: options }); }
  catch (e) {
    if (e?.name === 'InvalidStateError') throw new Error('This device already has a passkey for your account.');
    throw new Error(e?.name === 'NotAllowedError' ? 'Adding the passkey was cancelled.' : "Your device couldn't create a passkey.");
  }
  return api.post('/api/passkeys/register/verify', { token, response, name });
}

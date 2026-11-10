const bytes = new TextEncoder();
const hex = value => Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', bytes.encode(value)));
const signingKey = secret => crypto.subtle.importKey('raw', bytes.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
export async function issueTicket(url, secret, now = Date.now()) {
  const payload = `v1.${Math.floor(now / 1000) + 180}.${await digest(url)}`;
  return payload + '.' + hex(await crypto.subtle.sign('HMAC', await signingKey(secret), bytes.encode(payload)));
}
export async function verifyTicket(ticket, url, secret, now = Date.now()) {
  if (typeof ticket !== 'string' || !/^v1\.\d{10}\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(ticket)) return false;
  const [version, expires, hash, signature] = ticket.split('.');
  const remaining = Number(expires) - Math.floor(now / 1000);
  if (remaining <= 0 || remaining > 180 || hash !== await digest(url)) return false;
  return crypto.subtle.verify('HMAC', await signingKey(secret), Uint8Array.from(signature.match(/../g), h => parseInt(h,16)), bytes.encode(`${version}.${expires}.${hash}`));
}

/**
 * Reads the realm roles from an access token WITHOUT verifying it. This is for showing or hiding UI only: the
 * server verifies the token and answers 403 to non-admins, so a forged token gains nothing.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const data: unknown = JSON.parse(json);
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function isOrgAdmin(token: string | null | undefined): boolean {
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  const access = payload['realm_access'];
  if (access === null || typeof access !== 'object') return false;
  const roles = (access as { roles?: unknown }).roles;
  return Array.isArray(roles) && roles.includes('org_admin');
}

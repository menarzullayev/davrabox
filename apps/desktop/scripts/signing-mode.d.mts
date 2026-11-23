export type SigningPlatform = 'win' | 'mac' | 'linux';
export type SigningMethod = 'pfx' | 'azure' | 'apple' | 'none';
export class SigningConfigError extends Error {}
export function describeSigning(env: Record<string, string | undefined>, platform: SigningPlatform): { mode: 'signed' | 'unsigned'; method: SigningMethod };
export function signingMode(env: Record<string, string | undefined>, platform: SigningPlatform): 'signed' | 'unsigned';
export const SIGNING_VARIABLES: { win: { pfx: string[]; azure: string[] }; mac: string[] };

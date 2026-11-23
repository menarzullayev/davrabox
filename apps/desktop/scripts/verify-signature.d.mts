export class UsageError extends Error {}
export function parseArgs(argv: string[]): { file: string; platform: 'win' | 'mac' | undefined };
export function planVerification(file: string, platform: 'win' | 'mac' | 'linux' | undefined): { command: string; args: string[] }[];

type ReleaseEnvironment = Record<string, string | undefined>;
type CommandRunner = (command: string, args: string[], options: {encoding: 'utf8'}) => string;

export function betaBundleEnvironment(env: ReleaseEnvironment): ReleaseEnvironment;
export function notarizeBetaDmg(file: string, env: ReleaseEnvironment, execFile?: CommandRunner, wait?: (ms: number) => void): void;
export function validateStaple(file: string, execFile?: CommandRunner, wait?: (ms: number) => void): void;

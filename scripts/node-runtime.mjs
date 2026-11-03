// Checks that the Node binary about to be bundled into the desktop app is the
// supported engine and is self-contained (links only macOS system libraries).

/** Parse "26.9.0" or ">=26.9.0" into [major, minor, patch]. */
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(left, right) {
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

/**
 * @param {{version: string, engines: string | undefined, arch: string, libraries: string}} input
 *   libraries is `otool -L` output for the binary.
 * @returns {string[]} problems; empty when the binary can be bundled.
 */
export function checkBundledNode({ version, engines, arch, libraries }) {
  const problems = [];
  const current = parseVersion(version);
  const minimum = parseVersion(engines);
  if (!current) problems.push(`unrecognized Node version ${version}`);
  else if (minimum) {
    if (current[0] !== minimum[0]) problems.push(`Node major ${current[0]} does not match package.json engines ${engines} (major ${minimum[0]})`);
    else if (compare(current, minimum) < 0) problems.push(`Node ${version} is older than package.json engines ${engines}`);
  }
  if (!['arm64', 'x64'].includes(arch)) problems.push(`unsupported architecture ${arch}`);
  const linked = String(libraries).split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
  const foreign = linked.filter(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'));
  if (foreign.length) problems.push(`links non-system libraries: ${foreign.join(', ')}`);
  return problems;
}

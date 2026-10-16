import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {link, mkdir, open, readFile, rename, rm, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const VERSION = /^\d+\.\d+\.\d+-beta\.\d+$/;
const ARCHIVE = 'Agent Time.app.tar.gz';
const FILES = new Set([ARCHIVE, `${ARCHIVE}.sig`]);
const SHA256 = /^[a-f0-9]{64}$/;

function installerName(version) { return `Agent Time_${version}_aarch64.dmg`; }
function installerPath(version) { return `/install/${version}/${encodeURIComponent(installerName(version))}`; }

async function currentInstallerVersion(dataDir) {
  try {
    const version = (await readFile(join(dataDir, 'installer-current'), 'utf8')).trim();
    if (!VERSION.test(version)) throw new Error('Invalid current installer version');
    return version;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function reply(response, status, body = '', headers = {}) {
  response.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
  response.end(body);
}

function authorized(request, token) {
  const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readLimited(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function checkedBody(request, limit) {
  const expected = request.headers['x-content-sha256'];
  if (typeof expected !== 'string' || !SHA256.test(expected)) {
    const error = new Error('SHA-256 required');
    error.status = 400;
    throw error;
  }
  const body = await readLimited(request, limit);
  if (createHash('sha256').update(body).digest('hex') !== expected) {
    const error = new Error('SHA-256 mismatch');
    error.status = 422;
    throw error;
  }
  return body;
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function putImmutable(path, body) {
  await mkdir(join(path, '..'), {recursive: true});
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
    await link(temp, path);
  } finally { await rm(temp, {force: true}); }
}

async function replaceAtomic(path, body) {
  await mkdir(join(path, '..'), {recursive: true});
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, {force: true}); }
}

async function serveFile(response, path, contentType, cacheControl, extraHeaders = {}) {
  try {
    const info = await stat(path);
    response.writeHead(200, {'Content-Type': contentType, 'Content-Length': info.size, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff', ...extraHeaders});
    createReadStream(path).pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT') return reply(response, 404);
    throw error;
  }
}

export function createBetaFeed({dataDir, uploadToken, publicOrigin}) {
  if (!dataDir || !uploadToken || uploadToken.length < 32 || !/^https:\/\/[^/]+$/.test(publicOrigin)) {
    throw new Error('DATA_DIR, strong UPLOAD_TOKEN, and HTTPS PUBLIC_ORIGIN are required');
  }
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/healthz') return reply(response, 200, 'ok');
      if (request.method === 'GET' && path === '/icon.png') return await serveFile(response, fileURLToPath(new URL('./icon.png', import.meta.url)), 'image/png', 'public, max-age=86400');
      if (request.method === 'GET' && path === '/manrope.ttf') return await serveFile(response, fileURLToPath(new URL('./manrope.ttf', import.meta.url)), 'font/ttf', 'public, max-age=86400');
      if (request.method === 'GET' && path === '/') {
        const version = await currentInstallerVersion(dataDir);
        const installLink = version ? new URL(installerPath(version), publicOrigin).href : null;
        const {renderLandingPage} = await import('./landing.mjs');
        return reply(response, 200, renderLandingPage({version, installLink}), {
          'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'",
        });
      }
      if (request.method === 'GET' && path === '/beta/latest.json') {
        return await serveFile(response, join(dataDir, 'latest.json'), 'application/json; charset=utf-8', 'no-store');
      }
      const release = /^\/beta\/([^/]+)\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && release) {
        const [, version, encodedName] = release;
        const name = decodeURIComponent(encodedName);
        if (!VERSION.test(version) || !FILES.has(name)) return reply(response, 404);
        return await serveFile(response, join(dataDir, 'releases', version, name), name.endsWith('.sig') ? 'text/plain; charset=utf-8' : 'application/gzip', 'public, max-age=31536000, immutable');
      }
      const installer = /^\/install\/([^/]+)\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && installer) {
        const [, version, encodedName] = installer;
        if (!VERSION.test(version) || decodeURIComponent(encodedName) !== installerName(version)) return reply(response, 404);
        if (version !== await currentInstallerVersion(dataDir)) return reply(response, 404);
        return await serveFile(response, join(dataDir, 'installers', version, installerName(version)), 'application/x-apple-diskimage', 'no-store', {
          'Content-Disposition': `attachment; filename="${installerName(version)}"`, 'Referrer-Policy': 'no-referrer',
        });
      }
      if (!path.startsWith('/admin/')) return reply(response, 404);
      if (!authorized(request, uploadToken)) return reply(response, 401);

      if (request.method === 'PUT' && path === '/admin/installers/current') {
        const version = (await checkedBody(request, 128)).toString('utf8').trim();
        if (!VERSION.test(version) || !(await exists(join(dataDir, 'installers', version, installerName(version))))) return reply(response, 422);
        await replaceAtomic(join(dataDir, 'installer-current'), Buffer.from(`${version}\n`));
        return reply(response, 204);
      }
      if (request.method === 'DELETE' && path === '/admin/installers/current') {
        await rm(join(dataDir, 'installer-current'), {force: true});
        return reply(response, 204);
      }

      const installerUpload = /^\/admin\/installers\/([^/]+)\/([^/]+)$/.exec(path);
      if (request.method === 'PUT' && installerUpload) {
        const [, version, encodedName] = installerUpload;
        if (!VERSION.test(version) || decodeURIComponent(encodedName) !== installerName(version)) return reply(response, 404);
        const target = join(dataDir, 'installers', version, installerName(version));
        if (await exists(target)) return reply(response, 409);
        const body = await checkedBody(request, 200 * 1024 * 1024);
        try { await putImmutable(target, body); } catch (error) {
          if (error.code === 'EEXIST') return reply(response, 409);
          throw error;
        }
        return reply(response, 201);
      }

      const upload = /^\/admin\/releases\/([^/]+)\/([^/]+)$/.exec(path);
      if (request.method === 'PUT' && upload) {
        const [, version, encodedName] = upload;
        const name = decodeURIComponent(encodedName);
        if (!VERSION.test(version) || !FILES.has(name)) return reply(response, 404);
        const target = join(dataDir, 'releases', version, name);
        if (await exists(target)) return reply(response, 409);
        const body = await checkedBody(request, name.endsWith('.sig') ? 16 * 1024 : 200 * 1024 * 1024);
        try { await putImmutable(target, body); } catch (error) {
          if (error.code === 'EEXIST') return reply(response, 409);
          throw error;
        }
        return reply(response, 201);
      }
      if (request.method === 'PUT' && path === '/admin/manifest/candidate') {
        const body = await checkedBody(request, 64 * 1024);
        let manifest;
        try { manifest = JSON.parse(body.toString('utf8')); } catch { return reply(response, 422); }
        const version = manifest?.version;
        const platform = manifest?.platforms?.['darwin-aarch64'];
        if (!VERSION.test(version) || Object.keys(manifest.platforms ?? {}).length !== 1 || typeof manifest.notes !== 'string' ||
          platform?.url !== `${publicOrigin}/beta/${version}/${encodeURIComponent(ARCHIVE)}` || typeof platform.signature !== 'string') return reply(response, 422);
        const releaseDir = join(dataDir, 'releases', version);
        if (!(await exists(join(releaseDir, ARCHIVE)))) return reply(response, 422);
        const signature = (await readFile(join(releaseDir, `${ARCHIVE}.sig`), 'utf8')).trim();
        if (!signature || signature !== platform.signature.trim()) return reply(response, 422);
        await replaceAtomic(join(dataDir, 'latest.json.candidate'), body);
        return reply(response, 201);
      }
      if (request.method === 'POST' && path === '/admin/manifest/promote') {
        const candidate = join(dataDir, 'latest.json.candidate');
        if (!(await exists(candidate))) return reply(response, 409);
        await rename(candidate, join(dataDir, 'latest.json'));
        return reply(response, 204);
      }
      if (request.method === 'POST' && path === '/admin/manifest/withdraw') {
        await rm(join(dataDir, 'latest.json'), {force: true});
        return reply(response, 204);
      }
      return reply(response, 404);
    } catch (error) {
      if (error.status) return reply(response, error.status);
      if (error.code === 'ENOENT') return reply(response, 422);
      if (error instanceof URIError) return reply(response, 404);
      console.error('Beta feed request failed:', error);
      return reply(response, 500);
    }
  };
}

if (process.argv[1] && basename(process.argv[1]) === 'server.mjs') {
  const server = createServer(createBetaFeed({
    dataDir: process.env.DATA_DIR ?? '/data',
    uploadToken: process.env.UPLOAD_TOKEN,
    publicOrigin: process.env.PUBLIC_ORIGIN,
  }));
  server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

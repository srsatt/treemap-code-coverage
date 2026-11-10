#!/usr/bin/env node
import {createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const version = JSON.parse(readFileSync(path.resolve(here, '../package.json'), 'utf8')).version;

const help = `treemap-coverage ${version}

Usage: treemap-coverage <coverage-final.json | coverage-summary.json> [options]

Options:
  --root <dir>     Folder that holds the sources. Sources are read only from under it and the
                   current directory; report paths elsewhere are looked up under it by their
                   path in the tree. Default: the current directory.
  --no-sources     Skip the source preview.
  --port <number>  Port to listen on. Default: 4173.
  --open           Open the browser.
  -h, --help       Show this help.
  -v, --version    Show the version.
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      root: {type: 'string'}, port: {type: 'string', default: '4173'}, open: {type: 'boolean', default: false},
      'no-sources': {type: 'boolean', default: false}, help: {type: 'boolean', short: 'h'}, version: {type: 'boolean', short: 'v'},
    },
  });
} catch (error) {
  console.error(`${error.message}\n\n${help}`);
  process.exit(2);
}
const {values, positionals} = parsed;
if (values.help) {
  console.log(help);
  process.exit(0);
}
if (values.version) {
  console.log(version);
  process.exit(0);
}
if (positionals.length !== 1) {
  console.error(help);
  process.exit(2);
}
const reportPath = path.resolve(positionals[0]);
if (!existsSync(reportPath)) {
  console.error(`Report not found: ${reportPath}`);
  process.exit(1);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid port: ${values.port}`);
  process.exit(2);
}
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('The viewer is not built. Run "npm run build" in the package folder.');
  process.exit(1);
}

let reportName = 'coverage-final.json';
try {
  if (JSON.parse(readFileSync(reportPath, 'utf8')).total?.lines) reportName = 'coverage-summary.json';
} catch (error) {
  console.error(`${reportPath} is not valid JSON: ${error.message}`);
  process.exit(1);
}

let sourcesDir = null;
if (!values['no-sources']) {
  const {buildSources} = await import('../lib/build-sources.mjs');
  sourcesDir = mkdtempSync(path.join(tmpdir(), 'treemap-coverage-'));
  const root = values.root ?? process.cwd();
  let result;
  try {
    result = await buildSources({reportPath, out: path.join(sourcesDir, 'sources'), root});
  } catch (error) {
    console.error(`Could not build the source preview: ${error.message}`);
    rmSync(sourcesDir, {recursive: true, force: true});
    process.exit(1);
  }
  const {count, skipped} = result;
  console.log(`Sources: ${count} highlighted, ${skipped.missing} not found, ${skipped.large} too large`);
}

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function resolveFile(urlPath) {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  if (relative === reportName) return reportPath;
  const base = relative.startsWith('sources/') && sourcesDir ? sourcesDir : dist;
  const file = path.resolve(base, relative);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

const allowedHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const server = createServer((request, response) => {
  if (!allowedHost.test(request.headers.host ?? '')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  let file = null;
  try {
    file = resolveFile(new URL(request.url, 'http://localhost').pathname);
  } catch {}
  if (!file) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'});
  createReadStream(file).on('error', () => response.destroy()).pipe(response);
});

const cleanup = (code = 0) => {
  if (sourcesDir) rmSync(sourcesDir, {recursive: true, force: true});
  process.exit(code);
};
process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Pass --port.` : error.message);
  cleanup(1);
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${server.address().port}/`;
  console.log(`Coverage map at ${url}`);
  if (values.open) {
    const [command, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
    spawn(command, args, {stdio: 'ignore', detached: true}).on('error', () => {}).unref();
  }
});

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Fields offered for editing even when a picture does not have them yet.
const COMMON_TAGS = [
  'IFD0:Make',
  'IFD0:Model',
  'IFD0:Artist',
  'IFD0:Copyright',
  'IFD0:ImageDescription',
  'IFD0:Software',
  'ExifIFD:DateTimeOriginal',
  'ExifIFD:UserComment',
  'GPS:GPSLatitude',
  'GPS:GPSLongitude',
  'IPTC:ObjectName',
  'IPTC:Headline',
  'IPTC:Caption-Abstract',
  'IPTC:Keywords',
  'IPTC:By-line',
  'IPTC:CopyrightNotice',
  'IPTC:Credit',
  'IPTC:Source',
  'IPTC:City',
  'IPTC:Country-PrimaryLocationName',
  'XMP-dc:Title',
  'XMP-dc:Description',
  'XMP-dc:Creator',
  'XMP-dc:Rights',
  'XMP-dc:Subject',
  'XMP-xmp:Rating',
];

// Fields that describe the file or are computed by exiftool. Shown, never written.
const READ_ONLY_GROUPS = new Set(['File', 'Composite', 'ExifTool', 'System']);

// Fields that hold several values rather than one.
const LIST_TAGS = new Set(['IPTC:Keywords', 'XMP-dc:Subject']);

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9_-]+$/;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('exiftool', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message =
          err.code === 'ENOENT'
            ? 'exiftool is not installed. Install it with: brew install exiftool'
            : (stderr || err.message).trim();
        return reject(httpError(500, message));
      }
      resolve(stdout);
    });
  });
}

function chooseFile() {
  return new Promise((resolve) => {
    const script = 'POSIX path of (choose file with prompt "Choose a picture")';
    execFile('osascript', ['-e', script], (err, stdout) => {
      // Cancelling the dialog makes osascript fail; treat that as "no choice".
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

function resolveFile(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw httpError(400, 'Choose a picture first.');
  }
  const file = path.resolve(input.trim().replace(/^~(?=$|\/)/, os.homedir()));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw httpError(404, `File not found: ${file}`);
  }
  if (!stat.isFile()) throw httpError(400, `Not a file: ${file}`);
  return file;
}

function buildFields(raw) {
  const fields = [];
  const present = new Set();

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'SourceFile') continue;
    const colon = key.indexOf(':');
    const group = key.slice(0, colon);
    const isList = Array.isArray(value);
    const readonly =
      READ_ONLY_GROUPS.has(group) ||
      (typeof value === 'object' && !isList) ||
      String(value).startsWith('(Binary data');

    fields.push({
      key,
      group,
      tag: key.slice(colon + 1),
      value,
      type: isList || LIST_TAGS.has(key) ? 'list' : 'text',
      readonly,
    });
    present.add(key);
  }

  for (const key of COMMON_TAGS) {
    if (present.has(key)) continue;
    const colon = key.indexOf(':');
    fields.push({
      key,
      group: key.slice(0, colon),
      tag: key.slice(colon + 1),
      value: LIST_TAGS.has(key) ? [] : '',
      type: LIST_TAGS.has(key) ? 'list' : 'text',
      readonly: false,
    });
  }

  return fields;
}

async function readMetadata(file) {
  const stdout = await run(['-j', '-G1', '-a', '-charset', 'UTF8', file]);
  const [raw] = JSON.parse(stdout);
  return { path: file, fileName: path.basename(file), fields: buildFields(raw) };
}

async function writeMetadata(file, changes) {
  const args = ['-overwrite_original', '-charset', 'UTF8'];

  // exiftool does not reliably replace an existing list when the clear and the
  // new values are in one command, so clear list fields in a separate call first.
  const listKeys = changes.filter(({ value }) => Array.isArray(value)).map(({ key }) => key);
  if (listKeys.length > 0) {
    await run(['-overwrite_original', '-charset', 'UTF8', ...listKeys.map((key) => `-${key}=`), file]);
  }

  for (const { key, value } of changes) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw httpError(400, `Invalid field name: ${key}`);
    }
    if (READ_ONLY_GROUPS.has(key.split(':')[0])) {
      throw httpError(400, `${key} is read-only.`);
    }
    if (Array.isArray(value)) {
      // The list was cleared above, so the first value sets it and the rest are appended.
      const [first, ...rest] = value.map(String);
      args.push(`-${key}=${first ?? ''}`);
      for (const item of rest) args.push(`-${key}+=${item}`);
    } else {
      // An empty string deletes the field.
      args.push(`-${key}=${String(value ?? '')}`);
    }
  }

  if (args.length === 3) return;
  args.push(file);
  await run(args);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(httpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function sendFile(res, file, contentType) {
  const data = await fs.promises.readFile(file);
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return await sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/file') {
      return sendJson(res, 200, await readMetadata(resolveFile(url.searchParams.get('path'))));
    }

    if (req.method === 'GET' && url.pathname === '/api/preview') {
      const file = resolveFile(url.searchParams.get('path'));
      const contentType = IMAGE_TYPES[path.extname(file).toLowerCase()];
      if (!contentType) {
        throw httpError(415, 'Preview works for JPEG, PNG, GIF and WebP only.');
      }
      return await sendFile(res, file, contentType);
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = await readJson(req);
      const file = resolveFile(body.path);
      await writeMetadata(file, Array.isArray(body.changes) ? body.changes : []);
      return sendJson(res, 200, await readMetadata(file));
    }

    if (req.method === 'POST' && url.pathname === '/api/choose') {
      return sendJson(res, 200, { path: await chooseFile() });
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Metadata editor running at http://localhost:${PORT}`);
});

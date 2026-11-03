const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { kindOf, execTool, stripMetadata } = require('./lib/tools');

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

const COVER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

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

// Same idea for audio files.
const AUDIO_COMMON_TAGS = [
  'ID3:Title',
  'ID3:Artist',
  'ID3:Album',
  'ID3:Band',
  'ID3:Year',
  'ID3:Track',
  'ID3:Genre',
  'ID3:Comment',
  'ID3:Composer',
];

// Audio tags that can be written, from exiftool's ID3 name to ffmpeg's metadata key.
// exiftool cannot write MP3 files, so audio is written with ffmpeg.
const AUDIO_TAGS = {
  Title: 'title',
  Artist: 'artist',
  Album: 'album',
  Band: 'album_artist',
  Year: 'date',
  Track: 'track',
  Genre: 'genre',
  Comment: 'comment',
  Composer: 'composer',
};

// Fields that describe the file or are computed by exiftool. Shown, never written.
const READ_ONLY_GROUPS = new Set(['File', 'Composite', 'ExifTool', 'System']);

// Fields that hold several values rather than one.
const LIST_TAGS = new Set(['IPTC:Keywords', 'XMP-dc:Subject']);

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9_-]+$/;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Strips characters that would break the AppleScript string in a dialog prompt.
function forAppleScript(text) {
  return text.replace(/["\\]/g, '');
}

function run(args) {
  return execTool('exiftool', args);
}

function chooseFile(prompt) {
  return new Promise((resolve) => {
    const script = `POSIX path of (choose file with prompt "${forAppleScript(prompt)}")`;
    execFile('osascript', ['-e', script], (err, stdout) => {
      // Cancelling the dialog makes osascript fail; treat that as "no choice".
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

// Opens the macOS save dialog. Resolves to the chosen path, or null if cancelled.
function chooseSaveFile(defaultName) {
  return new Promise((resolve) => {
    const script = `POSIX path of (choose file name with prompt "Save as" default name "${forAppleScript(defaultName)}")`;
    execFile('osascript', ['-e', script], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

function resolveFile(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw httpError(400, 'Choose a file first.');
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

function isWritableAudio(group, tag) {
  return /^ID3/.test(group) && Object.hasOwn(AUDIO_TAGS, tag);
}

function buildFields(raw, kind) {
  const audio = kind === 'audio';
  const fields = [];
  const present = new Set();
  const presentTags = new Set();

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'SourceFile') continue;
    const colon = key.indexOf(':');
    const group = key.slice(0, colon);
    const tag = key.slice(colon + 1);

    // The cover image has its own controls, so it is not listed as a field.
    if (audio && /^ID3v2_\d:Picture/.test(key)) continue;

    const isList = Array.isArray(value);
    const readonly = audio
      ? !isWritableAudio(group, tag)
      : READ_ONLY_GROUPS.has(group) ||
        (typeof value === 'object' && !isList) ||
        String(value).startsWith('(Binary data');

    fields.push({
      key,
      group,
      tag,
      value,
      type: isList || LIST_TAGS.has(key) ? 'list' : 'text',
      readonly,
    });
    present.add(key);
    presentTags.add(tag);
  }

  for (const key of audio ? AUDIO_COMMON_TAGS : COMMON_TAGS) {
    const colon = key.indexOf(':');
    const tag = key.slice(colon + 1);
    // For audio, skip a common tag when the same tag is already listed under another ID3 version.
    if (present.has(key) || (audio && presentTags.has(tag))) continue;
    fields.push({
      key,
      group: key.slice(0, colon),
      tag,
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
  const kind = kindOf(file);
  return {
    path: file,
    fileName: path.basename(file),
    kind,
    hasCover: kind === 'audio' && Object.keys(raw).some((key) => /^ID3v2_\d:Picture$/.test(key)),
    fields: buildFields(raw, kind),
  };
}

async function writeImageMetadata(file, changes) {
  const args = ['-overwrite_original', '-charset', 'UTF8'];

  for (const { key, value } of changes) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw httpError(400, `Invalid field name: ${key}`);
    }
    if (READ_ONLY_GROUPS.has(key.split(':')[0])) {
      throw httpError(400, `${key} is read-only.`);
    }
    if (Array.isArray(value)) {
      // The list was cleared earlier, so the first value sets it and the rest are appended.
      const [first, ...rest] = value.map(String);
      args.push(`-${key}=${first ?? ''}`);
      for (const item of rest) args.push(`-${key}+=${item}`);
    } else {
      // An empty string deletes the field.
      args.push(`-${key}=${String(value ?? '')}`);
    }
  }

  if (changes.some(({ value }) => Array.isArray(value))) {
    // exiftool does not reliably replace an existing list when the clear and the
    // new values are in one command, so clear list fields in a separate call first.
    const listKeys = changes.filter(({ value }) => Array.isArray(value)).map(({ key }) => key);
    await run(['-overwrite_original', '-charset', 'UTF8', ...listKeys.map((key) => `-${key}=`), file]);
  }

  if (args.length === 3) return;
  args.push(file);
  await run(args);
}

// exiftool cannot write MP3 files, so audio tags and the cover are written with ffmpeg.
// The result goes to a temporary file that then replaces the original.
// cover: undefined = keep, 'remove' = drop, { image } = use that JPEG or PNG.
async function writeAudioMetadata(file, changes, cover) {
  const tagArgs = [];
  for (const { key, value } of changes) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw httpError(400, `Invalid field name: ${key}`);
    }
    const colon = key.indexOf(':');
    const group = key.slice(0, colon);
    const tag = key.slice(colon + 1);
    if (!isWritableAudio(group, tag)) throw httpError(400, `${key} is read-only.`);
    tagArgs.push('-metadata', `${AUDIO_TAGS[tag]}=${String(value ?? '')}`);
  }

  if (tagArgs.length === 0 && cover === undefined) return;

  const inputArgs = ['-i', file];
  let mapArgs = ['-map', '0'];
  const coverArgs = [];
  if (cover === 'remove') {
    mapArgs = ['-map', '0:a'];
  } else if (cover) {
    inputArgs.push('-i', cover.image);
    mapArgs = ['-map', '0:a', '-map', '1:v'];
    coverArgs.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  }

  const tmp = path.join(path.dirname(file), `.meta-tmp-${process.pid}-${Date.now()}.mp3`);
  const args = [
    '-y',
    '-loglevel', 'error',
    ...inputArgs,
    ...mapArgs,
    '-map_metadata', '0',
    '-c', 'copy',
    '-id3v2_version', '3',
    ...tagArgs,
    ...coverArgs,
    '-f', 'mp3',
    tmp,
  ];

  try {
    await execTool('ffmpeg', args);
    const { mode } = await fs.promises.stat(file);
    await fs.promises.chmod(tmp, mode & 0o777);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

function writeMetadata(file, changes, cover) {
  return kindOf(file) === 'audio'
    ? writeAudioMetadata(file, changes, cover)
    : writeImageMetadata(file, changes);
}

// Reads the request's cover field: undefined = keep, null = remove, { image } = replace.
function parseCover(value, file) {
  if (value === undefined) return undefined;
  if (kindOf(file) !== 'audio') throw httpError(400, 'Cover images can only be changed in audio files.');
  if (value === null) return 'remove';
  if (typeof value !== 'object' || typeof value.image !== 'string') {
    throw httpError(400, 'Invalid cover image.');
  }
  const image = resolveFile(value.image);
  if (!COVER_EXTENSIONS.has(path.extname(image).toLowerCase())) {
    throw httpError(400, 'Cover images must be JPEG or PNG.');
  }
  return { image };
}

async function readCover(file) {
  const data = await execTool('exiftool', ['-b', '-Picture', file], 'buffer');
  if (data.length === 0) throw httpError(404, 'No cover image.');
  return data;
}

function imageContentType(data) {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  return 'application/octet-stream';
}

// Next free "<name>-clean<ext>", "<name>-clean-2<ext>", ... beside the original.
function cleanCopyPath(file) {
  const { dir, name, ext } = path.parse(file);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? `${name}-clean${ext}` : `${name}-clean-${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

async function saveCleanCopy(file) {
  const dest = cleanCopyPath(file);
  await stripMetadata(file, dest);
  return dest;
}

function changesFrom(body) {
  return Array.isArray(body.changes) ? body.changes : [];
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

    if (req.method === 'GET' && url.pathname === '/api/cover') {
      const data = await readCover(resolveFile(url.searchParams.get('path')));
      res.writeHead(200, { 'Content-Type': imageContentType(data), 'Cache-Control': 'no-store' });
      return res.end(data);
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = await readJson(req);
      const file = resolveFile(body.path);
      await writeMetadata(file, changesFrom(body), parseCover(body.cover, file));
      return sendJson(res, 200, await readMetadata(file));
    }

    if (req.method === 'POST' && url.pathname === '/api/save-clean') {
      const body = await readJson(req);
      const file = resolveFile(body.path);
      return sendJson(res, 200, { path: await saveCleanCopy(file) });
    }

    if (req.method === 'POST' && url.pathname === '/api/save-as') {
      const body = await readJson(req);
      const file = resolveFile(body.path);
      const cover = parseCover(body.cover, file);
      const dest = await chooseSaveFile(path.basename(file));
      if (!dest) return sendJson(res, 200, { path: null });

      // Saving over the original is an ordinary save. Anything else is a new copy,
      // and existing files are never overwritten.
      if (path.resolve(dest) !== file) {
        if (fs.existsSync(dest)) {
          throw httpError(409, `${path.basename(dest)} already exists. Choose another name.`);
        }
        await fs.promises.copyFile(file, dest);
      }
      await writeMetadata(dest, changesFrom(body), cover);
      return sendJson(res, 200, await readMetadata(dest));
    }

    if (req.method === 'POST' && url.pathname === '/api/choose') {
      const body = await readJson(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt : 'Choose a file';
      return sendJson(res, 200, { path: await chooseFile(prompt) });
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Metadata editor running at http://localhost:${PORT}`);
});

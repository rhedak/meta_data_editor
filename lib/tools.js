const { execFile } = require('node:child_process');
const path = require('node:path');

const AUDIO_EXTENSIONS = new Set(['.mp3']);

const INSTALL_HINTS = {
  exiftool: 'brew install exiftool',
  ffmpeg: 'brew install ffmpeg',
};

function kindOf(file) {
  return AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()) ? 'audio' : 'image';
}

function execTool(tool, args, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    execFile(tool, args, { maxBuffer: 32 * 1024 * 1024, encoding }, (err, stdout, stderr) => {
      if (err) {
        const message =
          err.code === 'ENOENT'
            ? `${tool} is not installed. Install it with: ${INSTALL_HINTS[tool]}`
            : (String(stderr || '') || err.message).trim();
        return reject(new Error(message));
      }
      resolve(stdout);
    });
  });
}

// Writes a copy of src to dest with every metadata tag and the cover image removed.
// The source is only read. dest must not exist yet.
async function stripMetadata(src, dest) {
  if (kindOf(src) === 'audio') {
    await execTool('ffmpeg', [
      '-loglevel', 'error',
      '-i', src,
      '-map', '0:a',
      '-map_metadata', '-1',
      '-c', 'copy',
      '-fflags', '+bitexact',
      '-flags:a', '+bitexact',
      '-f', 'mp3',
      dest,
    ]);
  } else {
    // "-o" writes to the new file and leaves the source untouched.
    await execTool('exiftool', ['-all=', '-o', dest, src]);
  }
}

module.exports = { kindOf, execTool, stripMetadata };

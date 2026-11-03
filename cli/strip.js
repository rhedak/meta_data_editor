#!/usr/bin/env node
// Strips all metadata from every supported file under the input folder and
// writes clean copies to the output folder, keeping the folder structure.
// Usage: node cli/strip.js [input_dir] [output_dir]   (defaults: input, out)

const fs = require('node:fs');
const path = require('node:path');
const { stripMetadata } = require('../lib/tools');

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.mp3']);

const [inputArg = 'input', outputArg = 'out'] = process.argv.slice(2);
const inputDir = path.resolve(inputArg);
const outputDir = path.resolve(outputArg);

// Yields every file below dir, skipping hidden entries and the output folder.
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (full === outputDir) continue;
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function main() {
  if (!fs.existsSync(inputDir)) {
    console.error(`Input folder not found: ${inputDir}`);
    return 1;
  }
  if (inputDir === outputDir) {
    console.error('The input and output folders must be different.');
    return 1;
  }

  const files = [...walk(inputDir)].sort();
  let cleaned = 0;
  let skipped = 0;
  let failed = 0;

  for (const src of files) {
    const rel = path.relative(inputDir, src);
    if (!SUPPORTED.has(path.extname(src).toLowerCase())) {
      skipped++;
      console.log(`skip  ${rel} (unsupported type)`);
      continue;
    }

    // Output files are regenerated on every run, so an existing copy is replaced.
    const dest = path.join(outputDir, rel);
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.rm(dest, { force: true });
      await stripMetadata(src, dest);
      cleaned++;
      console.log(`ok    ${rel}`);
    } catch (err) {
      failed++;
      console.error(`fail  ${rel}: ${err.message}`);
    }
  }

  console.log(`\n${cleaned} cleaned, ${skipped} skipped, ${failed} failed. Output: ${outputDir}`);
  return failed ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
});

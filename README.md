# Metadata Editor

A small browser-based metadata editor. Open a picture or an MP3, see all its metadata grouped by type (EXIF, IPTC, XMP, GPS, ID3, ...), edit values, and save them back into the file. MP3 files also show their embedded cover image, which you can add, replace or remove.

## Requirements

- Node.js 18 or newer (no npm packages to install)
- [exiftool](https://exiftool.org), used to read metadata and to write pictures
- [ffmpeg](https://ffmpeg.org), used to write MP3 tags and cover images (exiftool cannot write MP3 files)

```bash
brew install exiftool ffmpeg
```

## Run

```bash
npm start
```

Then open http://localhost:3000 in your browser. Set a different port with `PORT=8080 npm start`.

## Batch strip metadata

To remove all metadata from many files at once, put them in `input/` (subfolders are fine), then run:

```bash
./strip.sh
```

Clean copies are written to `out/` with the same folder structure. The originals in `input/` are not changed, and existing files in `out/` are replaced. Files of other types are skipped. Supported types are JPEG, PNG, GIF, WebP, TIFF and MP3. Hidden files such as `.DS_Store` are ignored.

Run it with other folders if you like: `./strip.sh path/to/in path/to/out`. The command exits with status 1 if any file fails. `npm run strip` does the same thing.

Your files in `input/` and `out/` are git-ignored, so they will not be committed.

## Use

1. Click **Choose picture…** (macOS file dialog) or paste a path and press Enter.
2. Untick or tick **Hide empty fields** to show or hide fields without a value. A few common fields (camera make, copyright, keywords, title, GPS, or for MP3s title, artist, album, ...) are always listed so you can fill them in.
   For MP3s, **Add cover…**, **Replace cover…** and **Remove cover** change the embedded image. JPEG or PNG covers work best.
3. Edit values. Changed fields turn yellow.
4. Click **Save** (or press Cmd+S). Clear a value and save to delete that field.

List fields such as keywords take comma-separated values.

**Save as…** opens the macOS save dialog and writes the picture, including unsaved edits, to the file you choose. The new file then becomes the open picture; the original is left unchanged. Choosing an existing file name is refused, so nothing is overwritten.

**Save clean copy** writes a new file next to the original (`photo-clean.jpg`, then `photo-clean-2.jpg`, ...) with all metadata removed, including GPS location. The original is not changed. The button is available once there are no unsaved edits. Note that exiftool's `-all=` also drops the embedded colour profile, so colours may look slightly different in some apps.

## Notes

- **MP3 files are rewritten through ffmpeg.** Tags it does not map (for example some custom or lyrics frames) are dropped on save. Only the tags listed in the editor are written; the rest of the file's audio is copied unchanged.
- **Cover and tag changes on MP3s** are applied when you click Save or Save as, like other edits.
- **Saving overwrites the picture in place.** exiftool is run with `-overwrite_original`, so no `_original` backup is kept. Keep a copy of anything important.
- Fields from the `File`, `Composite` and `ExifTool` groups are computed or describe the file, so they are shown but cannot be edited.
- The server listens on `127.0.0.1` only, so it is not reachable from other machines.
- Previews work for JPEG, PNG, GIF and WebP. Other formats (such as HEIC) still open and edit, but without a preview.

## Files

- `server.js`: local Node server that wraps exiftool (read, write, file dialog, preview)
- `public/index.html`: the single-page UI

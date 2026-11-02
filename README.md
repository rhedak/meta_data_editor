# Metadata Editor

A small browser-based metadata editor. Right now it handles pictures: open one, see all its metadata grouped by type (EXIF, IPTC, XMP, GPS, ...), edit values, and save them back into the file.

## Requirements

- Node.js 18 or newer (no npm packages to install)
- [exiftool](https://exiftool.org), used to read and write the metadata

```bash
brew install exiftool
```

## Run

```bash
npm start
```

Then open http://localhost:3000 in your browser. Set a different port with `PORT=8080 npm start`.

## Use

1. Click **Choose picture…** (macOS file dialog) or paste a path and press Enter.
2. Untick or tick **Hide empty fields** to show or hide fields without a value. A few common fields (camera make, copyright, keywords, title, GPS, ...) are always listed so you can fill them in.
3. Edit values. Changed fields turn yellow.
4. Click **Save** (or press Cmd+S). Clear a value and save to delete that field.

List fields such as keywords take comma-separated values.

## Notes

- **Saving overwrites the picture in place.** exiftool is run with `-overwrite_original`, so no `_original` backup is kept. Keep a copy of anything important.
- Fields from the `File`, `Composite` and `ExifTool` groups are computed or describe the file, so they are shown but cannot be edited.
- The server listens on `127.0.0.1` only, so it is not reachable from other machines.
- Previews work for JPEG, PNG, GIF and WebP. Other formats (such as HEIC) still open and edit, but without a preview.

## Files

- `server.js`: local Node server that wraps exiftool (read, write, file dialog, preview)
- `public/index.html`: the single-page UI

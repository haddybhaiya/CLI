import { describe, it, expect } from 'vitest';
import { mimeTypeFromName } from './mime.js';

describe('mimeTypeFromName', () => {
  it('infers common types from the extension', () => {
    expect(mimeTypeFromName('photo.png')).toBe('image/png');
    expect(mimeTypeFromName('a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFromName('report.pdf')).toBe('application/pdf');
    expect(mimeTypeFromName('data.json')).toBe('application/json');
    expect(mimeTypeFromName('clip.mp4')).toBe('video/mp4');
  });

  it('is case-insensitive and handles full paths', () => {
    expect(mimeTypeFromName('IMG.PNG')).toBe('image/png');
    expect(mimeTypeFromName('/tmp/sub dir/cover.JPG')).toBe('image/jpeg');
    expect(mimeTypeFromName('archive.tar.gz')).toBe('application/gzip');
  });

  it('returns undefined for unknown or missing extensions', () => {
    expect(mimeTypeFromName('file.unknownext')).toBeUndefined();
    expect(mimeTypeFromName('noext')).toBeUndefined();
    expect(mimeTypeFromName('trailingdot.')).toBeUndefined();
    expect(mimeTypeFromName('.gitignore')).toBeUndefined();
  });
});

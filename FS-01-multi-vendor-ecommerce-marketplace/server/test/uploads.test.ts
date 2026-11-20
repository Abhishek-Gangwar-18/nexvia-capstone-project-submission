/**
 * Uploads: the real type is read from the file's bytes, and a URL only deletes a file its own uploader stored.
 * S3 is switched off here, so files go to server/uploads and are removed again; nothing else is touched.
 * Run: pnpm test
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.AWS_S3_BUCKET = ''; // dotenv never overrides a variable that is already set
const { env } = await import('../src/config/env.ts');
const { sniffImage, verifyImages } = await import('../src/middleware/upload.ts');
const { deleteFile, deleteReplaced, ownedKey, UPLOAD_DIR, uploadFile } = await import('../src/services/storage.ts');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pad = (head) => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(16)]);
const ALICE = 'a'.repeat(24);
const BOB = 'b'.repeat(24);
const exists = (file) => fs.access(file).then(() => true, () => false);

describe('image type check', () => {
  test('each allowed format is recognised from its first bytes', () => {
    assert.equal(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])), 'image/jpeg');
    assert.equal(sniffImage(PNG), 'image/png');
    assert.equal(sniffImage(pad('GIF89a')), 'image/gif');
    assert.equal(sniffImage(pad('RIFF\x00\x00\x00\x00WEBPVP8 ')), 'image/webp');
    assert.equal(sniffImage(pad('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00mif1')), 'image/avif');
  });

  test('pages, scripts, SVGs and other video containers are refused', () => {
    assert.equal(sniffImage(pad('<!doctype html><script>')), null);
    assert.equal(sniffImage(pad('<svg xmlns="http://www.w3.org/2000/svg">')), null);
    assert.equal(sniffImage(pad('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00isom')), null);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);
  });

  test('a renamed HTML file is rejected, and a real image is stored under its real type', () => {
    let error;
    verifyImages({ files: [{ originalname: 'cat.png', mimetype: 'image/png', buffer: pad('<html>') }] }, {}, (err: any) => (error = err));
    assert.equal(error?.status, 400);

    const file = { originalname: 'cat.jpg', mimetype: 'image/jpeg', buffer: PNG };
    verifyImages({ files: [file] }, {}, (err: any) => (error = err));
    assert.equal(error, undefined);
    assert.equal(file.mimetype, 'image/png');
  });
});

describe('deleting replaced images', () => {
  const folderOf = (owner) => path.join(UPLOAD_DIR, 'avatars', new Date().toISOString().slice(0, 10), owner);
  after(() => fs.rm(folderOf(ALICE), { recursive: true, force: true }));

  test("an uploaded file is deleted only by its own uploader, and only once it is no longer used", async () => {
    const { url, key } = await uploadFile({ buffer: PNG, mimetype: 'image/png' }, 'avatars', ALICE);
    const file = path.join(UPLOAD_DIR, key);
    assert.ok(url.startsWith(`${env.serverUrl}/uploads/avatars/`));
    assert.equal(ownedKey(url, ALICE), key);
    assert.equal(ownedKey(url, BOB), null);

    await deleteReplaced([url], [url], ALICE);
    assert.ok(await exists(file), 'a kept image was deleted');
    await deleteReplaced([url], [], BOB);
    assert.ok(await exists(file), "another user's image was deleted");
    await deleteReplaced([url, 'https://images.example.com/seeded.jpg', ''], [], ALICE);
    assert.equal(await exists(file), false, 'the replaced image is still there');
  });

  test('a key outside the upload folders is never deleted', async () => {
    const sentinel = path.join(UPLOAD_DIR, '..', `upload-test-${process.pid}.txt`);
    await fs.writeFile(sentinel, 'keep me');
    try {
      assert.equal(await deleteFile(`../${path.basename(sentinel)}`), false);
      assert.equal(await deleteFile(`avatars/2026-10-30/${ALICE}/../../../../${path.basename(sentinel)}`), false);
      assert.ok(await exists(sentinel));
    } finally {
      await fs.rm(sentinel, { force: true });
    }
  });
});

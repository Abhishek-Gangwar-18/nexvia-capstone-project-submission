/**
 * Live check of the S3 bucket in server/.env: upload, public read, delete, and that the bucket can't be listed.
 * Writes one 1x1 test image under products/ and deletes it again. MongoDB and Redis are not touched.
 * Run: pnpm s3:check
 */
import { env } from '../src/config/env.ts';
import { deleteFile, ownedKey, storageDriver, uploadFile } from '../src/services/storage.ts';

const { aws } = env;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const OWNER = '0'.repeat(24);

let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? ` (${detail})` : ''}`);
    return true;
  } catch (err) {
    failed += 1;
    console.log(`  \x1b[31m✖\x1b[0m ${name}: ${err.message}`);
    return false;
  }
}
const expect = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** What to check for the usual S3 errors (same idea as the Redis hints in services/cache.ts). */
function s3Hint(err) {
  const code = err.name || err.Code || '';
  if (code === 'InvalidAccessKeyId') return ' -> AWS_ACCESS_KEY_ID is wrong or the key was deleted (IAM > Users > vendora-api > Security credentials)';
  if (code === 'SignatureDoesNotMatch') return ' -> AWS_SECRET_ACCESS_KEY is wrong (check for a missing character or a copied space)';
  if (code === 'AccessDenied') return ' -> the IAM user needs s3:PutObject and s3:DeleteObject on arn:aws:s3:::<bucket>/*';
  if (code === 'NoSuchBucket') return ' -> AWS_S3_BUCKET does not match the bucket name';
  if (code === 'PermanentRedirect' || code === 'AuthorizationHeaderMalformed') return ' -> the bucket is in another region than AWS_REGION';
  if (code === 'RequestTimeTooSkewed') return " -> this computer's clock is off; sync it in Windows date & time settings";
  return '';
}

if (storageDriver() !== 's3') {
  const missing = ['AWS_S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((name) => !process.env[name]);
  console.log(`S3 is not configured: set ${missing.join(', ')} in server/.env`);
  process.exit(1);
}

console.log(`\nS3 checks (bucket "${aws.bucket}", ${aws.region}):`);
let uploaded = null;
await check('upload an image (s3:PutObject)', async () => {
  try {
    uploaded = await uploadFile({ buffer: PNG, mimetype: 'image/png' }, 'products', OWNER);
  } catch (err) {
    throw new Error(`${err.name}: ${err.message}${s3Hint(err)}`);
  }
  return uploaded.key;
});

if (uploaded) {
  const { url, key } = uploaded;
  await check('the public URL serves it (bucket policy allows reading products/*)', async () => {
    const res = await fetch(url);
    expect(
      res.ok,
      `${res.status} for ${url}${res.status === 403 ? ' -> add the public-read bucket policy and untick the two "bucket policies" boxes in Block Public Access' : ''}`,
    );
    expect(res.headers.get('content-type') === 'image/png', `served as ${res.headers.get('content-type')}`);
    return `${res.status}, ${res.headers.get('cache-control')}`;
  });
  await check('the URL maps back to its key (used to delete replaced images)', async () => {
    expect(ownedKey(url, OWNER) === key, `got ${ownedKey(url, OWNER)}`);
    expect(ownedKey(url, 'f'.repeat(24)) === null, "another user's id was accepted");
  });
  await check('delete it (s3:DeleteObject)', async () => {
    expect(await deleteFile(key), 'delete failed (see the warning above) -> the IAM user needs s3:DeleteObject');
    const res = await fetch(url);
    expect(res.status === 403 || res.status === 404, `still served (${res.status}) after delete`);
    return `now ${res.status}`;
  });
}

if (!aws.publicUrl && !aws.endpoint) {
  await check('the bucket contents cannot be listed publicly', async () => {
    const res = await fetch(`https://${aws.bucket}.s3.${aws.region}.amazonaws.com/`);
    expect(res.status === 403, `listing answered ${res.status} -> remove s3:ListBucket for "*" from the bucket policy`);
    return '403';
  });
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll S3 checks passed.');
process.exit(failed ? 1 : 0);

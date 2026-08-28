import assert from 'node:assert/strict';
import { bestBackupCompression, encryptBackup, decryptBackup } from '../extension/js/crypto-backup.js';

const data = {
  type: 'chatpanel-backup',
  version: 6,
  conversations: [{ id: 'c1', messages: [{ role: 'user', content: 'portable encrypted backup '.repeat(5000) }] }],
  meetings: [],
};
const envelope = await encryptBackup(data, 'correct horse battery staple');
assert.ok(['brotli', 'gzip', 'none'].includes(envelope.compression));
assert.equal(envelope.compression, bestBackupCompression());
assert.deepEqual(await decryptBackup(envelope, 'correct horse battery staple'), data);
await assert.rejects(() => decryptBackup(envelope, 'wrong'), /Wrong password/);
if (envelope.compression !== 'none') {
  assert.ok(envelope.ct.length < JSON.stringify(data).length / 2, 'repetitive text should compress substantially before encryption');
}
console.log(`crypto backup tests passed (${envelope.compression})`);

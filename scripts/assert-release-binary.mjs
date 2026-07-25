// Guard for the `test-release-profile` CI job: fail loudly unless the binary
// the suite is about to exercise really is the shipped profile.
//
// Without this the job degrades into a second debug run the moment the build
// step changes or a stale `.node` is picked up — a green tick that proves
// nothing, which is precisely the failure this job exists to catch. `abort`
// is checked too, since a release build that cannot convert a panic is the
// original defect and would otherwise only surface as a suite-wide crash.
//
// Usage: node scripts/assert-release-binary.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = pathToFileURL(join(repoRoot, 'packages', 'mille', 'dist', 'index.js')).href;

const { buildIdentity } = await import(entry);
const identity = buildIdentity();

console.log(JSON.stringify(identity, null, 2));

const problems = [];
if (identity.nativeProfile !== 'release') {
  problems.push(`nativeProfile is "${identity.nativeProfile}", expected "release"`);
}
if (identity.nativePanicStrategy !== 'unwind') {
  problems.push(`nativePanicStrategy is "${identity.nativePanicStrategy}", expected "unwind"`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  console.error('\nThe release-profile job is not testing what it claims to test.');
  process.exit(1);
}

console.log('\nRelease binary confirmed: profile=release, panic=unwind');

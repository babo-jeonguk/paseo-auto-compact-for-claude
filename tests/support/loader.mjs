// The unit-test scripts load TypeScript through this module rather than
// through tsx directly. tsx keeps a cache of what it compiles in the temp
// directory and writes each entry asynchronously, inside the test process,
// after compiling a file it has not cached: on the first run after a file
// changes, and on every run in CI. drained() rightly reports those writes as
// pending work. With the cache off, tsx keeps what it compiles in memory only
// and writes nothing; compiling every file afresh costs the full suite about
// half a second. tsx reads TSX_DISABLE_CACHE as it loads (its CLI's --no-cache
// sets the same variable), so it is set before tsx is imported.
process.env.TSX_DISABLE_CACHE = '1';
await import('tsx');

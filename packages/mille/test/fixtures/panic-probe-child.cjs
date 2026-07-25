// Child half of `panic-boundary.test.mjs`. Calls a deliberately panicking
// native entry point and reports whether the panic arrived as a JS error.
//
// This has to be a separate process: when the guard regresses the panic aborts
// the runtime, and a caller in-process cannot observe its own SIGABRT. The
// parent reads the exit signal to tell "threw" from "died".
//
// argv: <nativePath> <"sync"|"async">

const [, , nativePath, which] = process.argv;
const native = require(nativePath);

function report(err) {
  console.log(`CAUGHT: ${err && err.message}`);
  process.exit(0);
}

if (which === 'sync') {
  try {
    native.__panicProbeSync();
  } catch (err) {
    report(err);
  }
  console.log('UNCAUGHT: returned normally');
  process.exit(3);
} else {
  native.__panicProbeAsync().then(
    () => {
      console.log('UNCAUGHT: resolved normally');
      process.exit(3);
    },
    (err) => report(err),
  );
}

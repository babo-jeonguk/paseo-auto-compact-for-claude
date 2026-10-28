export class DeadlineExceeded extends Error {
  constructor() { super("Compaction deadline exceeded"); }
}

// Attaching both handlers also consumes late rejections after the timer wins.
// A timeout bounds waiting; it does not cancel a remote side effect.
export function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceeded()), Math.max(0, milliseconds));
    work.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

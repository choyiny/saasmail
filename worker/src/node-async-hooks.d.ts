// The one Node.js API the worker uses: AsyncLocalStorage, which the Workers
// runtime provides under the `nodejs_compat` flag. Declared here instead of
// installing @types/node, whose globals would clash with the Workers types.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    /** Runs `callback` with `store` visible to everything it awaits. */
    run<R>(store: T, callback: () => R): R;
    /** The store of the enclosing `run`, if any. */
    getStore(): T | undefined;
  }
}

# scripts/ gotchas

- A script's entry-point guard compares real paths (`realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`), not `process.argv[1] === fileURLToPath(import.meta.url)`: through a symlinked path (macOS `/tmp`, a symlinked clone) the plain check is false, `main()` never runs and the script exits 0. Check: `node <symlinked path>/scripts/<name>.mjs` with no arguments prints usage and exits 1.

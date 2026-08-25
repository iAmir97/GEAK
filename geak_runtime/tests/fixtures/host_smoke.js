export const meta = { name: "host-smoke" };
phase("Setup");
log("host smoke", args.value);
return { eval_dir: args.eval_dir, value: args.value, harness: "omp" };

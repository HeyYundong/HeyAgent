import { spawnSync } from "node:child_process"
const r = spawnSync("/bin/bash", [process.argv[2]], { stdio: "inherit" })
process.exit(r.status ?? 1)

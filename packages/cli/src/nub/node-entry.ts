// Their src/node/index.ts ends with a top-level `await import("../index")`, which
// nub compile cannot carry: Rolldown lowers an async module to a lazy initializer
// and the graph's import cycles then deadlock. Same imports, static, no await.
import "../node/plugin-runtime.promise"
import "../node/plugin-runtime.effect"
import "../index"

process.stdout.on("error", (error) => {
  if ("code" in error && error.code === "EPIPE") return
  throw error
})

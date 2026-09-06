// Stands in for vite's `virtual:opencode-app-assets`, which only their vite
// build can produce. `load` treats a zero-length archive as "not embedded" and
// falls through, so the TUI starts without the web UI rather than failing on it.
export default ""

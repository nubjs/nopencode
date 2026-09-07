/**
 * The per-platform package each native dependency family ships its binary in.
 *
 * All four publish one package per platform and none of them spells the suffix
 * the same way: the libc token is `glibc`/`musl` for `@parcel/watcher` and
 * `gnu`/`musl` for two more, `@lydell/node-pty` omits it, and only `ffi-rs`
 * tags Windows `-msvc`. The default is `<platform>-<arch>`; an entry overrides
 * only the platform where it differs.
 *
 * Kept apart from the build script so the naming can be checked against an
 * install for platforms this host cannot build on.
 */
export const NATIVE = {
  "@parcel/watcher": { linux: (arch, libc) => `linux-${arch}-${libc}` },
  "@lydell/node-pty": { linux: (arch) => `linux-${arch}` },
  "@ff-labs/fff-bin": { linux: (arch, libc) => `linux-${arch}-${libc === "musl" ? "musl" : "gnu"}` },
  "@yuuang/ffi-rs": {
    linux: (arch, libc) => `linux-${arch}-${libc === "musl" ? "musl" : "gnu"}`,
    win32: (arch) => `win32-${arch}-msvc`,
  },
}

/** glibc reports a runtime version here and musl does not — the only libc signal Node exposes. */
export function hostLibc() {
  return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl"
}

export function nativePackage(name, platform = process.platform, arch = process.arch, libc = hostLibc()) {
  const rule = NATIVE[name][platform]
  return `${name}-${rule ? rule(arch, libc) : `${platform}-${arch}`}`
}

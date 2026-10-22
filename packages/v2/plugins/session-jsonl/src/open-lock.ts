import { dlopen, FFIType, read } from "bun:ffi";
import { stop } from "./fail";

export function openLock() {
  const mac = process.platform === "darwin";

  if (!mac && process.platform !== "linux") stop("configuration-conflict");

  const errnoName = mac ? "__error" : "__errno_location";
  const library = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoName]: { args: [], returns: FFIType.ptr },
  });
  return {
    try(fd: number): boolean {
      if (library.symbols.flock!(fd, 6) === 0) return true;

      const pointer = library.symbols[errnoName]!();

      if (!pointer) stop("storage-unavailable");

      const code = read.i32(pointer);

      if (code === (mac ? 35 : 11) || code === 4) return false;

      stop("storage-unavailable");
    },
    unlock(fd: number): void {
      if (library.symbols.flock!(fd, 8) !== 0) stop("storage-unavailable");
    },
    close(): void {
      library.close();
    },
  };
}

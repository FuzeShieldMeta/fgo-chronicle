import { open } from "node:fs/promises";
import { constants } from "node:fs";

/** @param {string} file @param {number} max */
export async function readBoundedFile(file, max) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error("The source file exceeds its size limit.");
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > max) throw new Error("The source file exceeds its size limit.");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

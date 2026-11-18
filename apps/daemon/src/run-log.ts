import { open } from 'node:fs/promises';

const PAGE_BYTES = 64 * 1024;

/** Byte cursors let the viewer page backwards without rereading the whole file. */
export async function readRunLog(path: string, before?: number): Promise<{ text: string; before: number | null }> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('日志路径不是文件');
    const end = Math.min(before ?? stat.size, stat.size);
    const start = Math.max(0, end - PAGE_BYTES);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    // If the page starts inside a UTF-8 character, leave that character to the earlier page.
    let offset = 0;
    while (start > 0 && offset < bytesRead && (buffer[offset]! & 0xc0) === 0x80) offset++;
    return {
      text: buffer.toString('utf8', offset, bytesRead),
      before: start === 0 ? null : start + offset,
    };
  } finally {
    await file.close();
  }
}

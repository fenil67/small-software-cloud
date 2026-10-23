import path from "path";
import unzipper from "unzipper";

export class ZipValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipValidationError";
  }
}

const MAX_FILES = 1000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MB

export async function validateZip(buffer: Buffer): Promise<void> {
  const directory = await unzipper.Open.buffer(buffer);

  if (directory.files.length > MAX_FILES) {
    throw new ZipValidationError(
      `Zip contains ${directory.files.length} entries; maximum is ${MAX_FILES}.`,
    );
  }

  let totalUncompressed = 0;

  for (const file of directory.files) {
    if ((file.type as string) === "SymbolicLink") {
      throw new ZipValidationError(
        `Zip contains a symbolic link: ${file.path}. Symbolic links are not allowed.`,
      );
    }

    const normalized = path.posix.normalize(file.path.replace(/\\/g, "/"));
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      throw new ZipValidationError(
        `Zip contains an unsafe path: ${file.path}.`,
      );
    }

    const basename = path.basename(normalized);
    if (basename === ".env" || /^\.env\./.test(basename)) {
      throw new ZipValidationError(
        `Zip contains a .env file: ${file.path}. Remove sensitive files before uploading.`,
      );
    }

    // Use actual compressed→decompressed size by streaming the entry
    // to count real bytes (not trusting declared header uncompressedSize)
    if ((file.type as string) !== "Directory") {
      const actualSize = await streamCountBytes(file);
      totalUncompressed += actualSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new ZipValidationError(
          `Zip uncompressed size exceeds 512 MB limit.`,
        );
      }
    }
  }
}

async function streamCountBytes(
  file: unzipper.File,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let total = 0;
    const stream = file.stream();
    stream.on("data", (chunk: Buffer) => { total += chunk.length; });
    stream.on("end", () => resolve(total));
    stream.on("error", reject);
  });
}

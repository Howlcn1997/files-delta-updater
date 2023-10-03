import crypto, { BinaryToTextEncoding } from "crypto";

export function stringHash(
  str,
  outputEncoding: BinaryToTextEncoding = "hex"
): string {
  const hash = crypto.createHash("sha512");
  hash.update(str);
  return hash.digest(outputEncoding).substring(0, 16);
}

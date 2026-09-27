// hex 编解码（零依赖单点）
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return new Uint8Array(0);
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

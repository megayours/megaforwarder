export const hexToBuffer = (hex: string): Buffer => {
  return Buffer.from(hex.replace('0x', ''), 'hex');
}

export const bufferToHex = (buffer: Buffer): string => {
  return buffer.toString('hex').toLowerCase();
}
// Pure snapshot encoding/decoding and replica merge rules.
export const qx = value => Math.round(value * 256);
export const qy = value => Math.round(value * 512);
export const qa = angle => Math.round(angle / (2 * Math.PI) * 65536) & 0xFFFF;
export const dx = value => value / 256;
export const dy = value => value / 512;
export const da = value => {
  const angle = value / 65536 * 2 * Math.PI;
  return angle > Math.PI ? angle - 2 * Math.PI : angle;
};
export const rowsEqual = (a, b) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export function mergeSnapshot(fullP, fullB, packet) {
  for (const row of packet.p ?? [])
    fullP.set(row[0], [dx(row[1]), dy(row[2]), dx(row[3]), da(row[4]), row[5],
      row[6], row[7], row[8], row[9], row[10], row[11], row[12], row[13], row[14]]);
  for (const row of packet.b ?? [])
    fullB.set(row[0], [dx(row[1]), dy(row[2]), dx(row[3]), da(row[4]), row[5],
      row[6], row[7], row[8], row[9]]);
  for (const index of packet.rm?.p ?? []) fullP.delete(index);
  for (const index of packet.rm?.b ?? []) fullB.delete(index);
}

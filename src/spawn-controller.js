/** Policy-only spawn adapter; Game supplies candidate and visibility details. */
export function chooseSpawn(ctx, team, preference = 'front') {
  if (preference === 'base') return ctx.base(team);
  if (ctx.mode === 'ctf') {
    const point = ctx.ctf(team);
    if (point) return point;
  }
  if (ctx.mode === 'tdm' || ctx.mode === 'koth') {
    const point = ctx.dynamic(team);
    if (point) return point;
  }
  return ctx.base(team);
}

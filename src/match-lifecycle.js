/** Pure match-clock transition; Game performs the returned side effects. */
export function advanceMatchClock(state, dt, decision) {
  if (state.over) return { ...state, event: null };
  const step = Math.max(0, dt);
  const elapsed = state.elapsed + step;
  if (state.overtime) return { ...state, elapsed, event: 'overtimeTick' };
  const remaining = Math.max(0, state.remaining - step);
  if (state.remaining > 0 && remaining <= 0) {
    const result = decision();
    return { ...state, elapsed, remaining,
      event: result.winner ? ['end', result.winner] : 'startOvertime' };
  }
  return { ...state, elapsed, remaining, event: null };
}

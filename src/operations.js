// operations.js — pure state for optional three-match session arcs.
//
// Operations package existing matches without changing their rules. Alpha
// and Bravo identify the two human groups across rounds; green/blue can still
// swap sides between maps without corrupting the series score.

export const OPERATION_PLANS = Object.freeze([
  Object.freeze({
    name: 'HIGH GROUND',
    legs: Object.freeze([
      Object.freeze({ mode: 'koth', map: 4 }), // CROWN
      Object.freeze({ mode: 'ctf', map: 2 }),  // PINEFALL
      Object.freeze({ mode: 'tdm', map: 0 }),  // GREENBELT
    ]),
  }),
  Object.freeze({
    name: 'ASH WAKE',
    legs: Object.freeze([
      Object.freeze({ mode: 'koth', map: 5 }), // CALDERA
      Object.freeze({ mode: 'ctf', map: 1 }),  // BEACHHEAD
      Object.freeze({ mode: 'tdm', map: 3 }),  // DUNES
    ]),
  }),
  Object.freeze({
    name: 'LONG SHADOW',
    legs: Object.freeze([
      Object.freeze({ mode: 'koth', map: 3 }), // DUNES
      Object.freeze({ mode: 'ctf', map: 0 }),  // GREENBELT
      Object.freeze({ mode: 'tdm', map: 4 }),  // CROWN
    ]),
  }),
]);

const sideIndex = side => side === 'bravo' || side === 1 ? 1 : 0;

export function createOperation(plan = 0) {
  const index = Number.isInteger(plan) && OPERATION_PLANS[plan] ? plan : 0;
  return { plan: index, leg: 0, wins: [0, 0], greenSide: 0, results: [] };
}

export function operationComplete(operation) {
  return !!operation && operation.results.length >= OPERATION_PLANS[operation.plan].legs.length;
}

export function operationLeg(operation, offset = 0) {
  if (!operation || !OPERATION_PLANS[operation.plan]) return null;
  return OPERATION_PLANS[operation.plan].legs[operation.leg + offset] ?? null;
}

export function operationSideForColor(operation, color) {
  if (!operation || (color !== 'green' && color !== 'blue')) return null;
  const index = color === 'green' ? operation.greenSide : 1 - operation.greenSide;
  return index === 0 ? 'alpha' : 'bravo';
}

export function recordOperationResult(operation, winnerColor) {
  if (!operation || operationComplete(operation)
      || operation.results.length > operation.leg) return operation;
  const side = operationSideForColor(operation, winnerColor);
  if (!side) return operation;
  const winner = sideIndex(side);
  const wins = [...operation.wins];
  wins[winner]++;
  return { ...operation, wins, results: [...operation.results, winner] };
}

export function advanceOperation(operation) {
  if (!operation || operationComplete(operation)
      || operation.results.length !== operation.leg + 1) return operation;
  return { ...operation, leg: operation.leg + 1 };
}

// Game#_restartRound flips every player between green and blue. Mirror that
// here so Alpha/Bravo remains attached to people, not the map-side color.
export function flipOperationColors(operation) {
  return operation ? { ...operation, greenSide: 1 - operation.greenSide } : null;
}

export function operationWinner(operation) {
  if (!operationComplete(operation)) return null;
  if (operation.wins[0] === operation.wins[1]) return 'draw';
  return operation.wins[0] > operation.wins[1] ? 'alpha' : 'bravo';
}

// Compact bounded row used by welcome, snapshot, end, and restart packets:
// [plan, current leg, alpha wins, bravo wins, green-side index, ...winners].
export function operationRow(operation) {
  return operation
    ? [operation.plan, operation.leg, operation.wins[0], operation.wins[1],
        operation.greenSide, ...operation.results]
    : null;
}

export function validOperationRow(row) {
  if (!Array.isArray(row) || row.length < 5 || row.length > 8
      || !row.every(Number.isInteger)) return false;
  const [plan, leg, alpha, bravo, greenSide, ...results] = row;
  const legs = OPERATION_PLANS[plan]?.legs.length;
  if (!legs || leg < 0 || leg >= legs || greenSide < 0 || greenSide > 1
      || alpha < 0 || bravo < 0 || alpha + bravo !== results.length
      || results.length > legs || !results.every(side => side === 0 || side === 1)) return false;
  return results.length === leg || results.length === leg + 1;
}

export function operationFromRow(row) {
  if (!validOperationRow(row)) return null;
  const [plan, leg, alpha, bravo, greenSide, ...results] = row;
  return { plan, leg, wins: [alpha, bravo], greenSide, results };
}

export function operationSideLabel(side) {
  return side === 'bravo' || side === 1 ? 'BRAVO' : 'ALPHA';
}

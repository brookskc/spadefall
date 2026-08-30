// match-report.js — pure post-match ranking, medal, and personal-record rules.
// The host-authored contribution table is the only input; none of this feeds
// points back into the match or creates a second progression economy.
import { contributionRow, rankContributionRows } from './scoring.js';

export const RECORD_FIELDS = Object.freeze([
  { key: 'score', label: 'SCORE' },
  { key: 'k', label: 'KILLS' },
  { key: 'a', label: 'ASSISTS' },
  { key: 'objective', label: 'OBJECTIVE' },
]);

const modeKey = mode => ['ctf', 'tdm', 'koth'].includes(mode) ? mode : 'tdm';
const cleanValue = value => Math.max(0, Math.round(Number(value) || 0));

export function medalAwards(row, rankedEntries) {
  const r = contributionRow(row);
  const ranked = rankContributionRows(rankedEntries ?? []);
  const max = key => Math.max(0, ...ranked.map(([, value]) => cleanValue(value?.[key])));
  const awards = [];
  if (ranked[0] && contributionRow(ranked[0][1]).score >= 250
      && cleanValue(ranked[0][1].score) === cleanValue(r.score))
    awards.push({ id: 'mvp', name: 'MATCH MVP', detail: 'highest contribution score' });
  if (cleanValue(r.objective) >= 2 && cleanValue(r.objective) === max('objective'))
    awards.push({ id: 'objective', name: 'OBJECTIVE LEAD', detail: 'most objective work' });
  if (cleanValue(r.k) >= 3 && cleanValue(r.k) === max('k'))
    awards.push({ id: 'kills', name: 'TOP GUN', detail: 'most eliminations' });
  if (cleanValue(r.a) >= 2 && cleanValue(r.a) === max('a'))
    awards.push({ id: 'assists', name: 'WINGMAN', detail: 'most assists' });
  if (cleanValue(r.d) === 0 && cleanValue(r.k) >= 3)
    awards.push({ id: 'survivor', name: 'SURVIVOR', detail: 'three kills without a death' });
  return awards.slice(0, 3);
}

export function buildMatchReport(localKey, entries) {
  const ranked = rankContributionRows(entries ?? []);
  let overallIndex = ranked.findIndex(([key]) => key === localKey);
  if (overallIndex < 0) overallIndex = 0;
  const local = contributionRow(ranked[overallIndex]?.[1]);
  const teamRows = ranked.filter(([, row]) => contributionRow(row).team === local.team);
  const teamIndex = Math.max(0, teamRows.findIndex(([key]) => key === localKey));
  return {
    local,
    overallRank: overallIndex + 1,
    overallSize: Math.max(1, ranked.length),
    teamRank: teamIndex + 1,
    teamSize: Math.max(1, teamRows.length),
    medals: medalAwards(local, ranked),
  };
}

export function updatePersonalBests(records, mode, row) {
  const key = modeKey(mode);
  const before = records && typeof records === 'object' ? records : {};
  const oldMode = before[key] && typeof before[key] === 'object' ? before[key] : {};
  const nextMode = {}, newBests = [];
  for (const field of RECORD_FIELDS) {
    const previous = cleanValue(oldMode[field.key]);
    const value = cleanValue(row?.[field.key]);
    nextMode[field.key] = Math.max(previous, value);
    if (value > previous && value > 0)
      newBests.push({ field: field.key, label: field.label, value, previous });
  }
  return { records: { ...before, [key]: nextMode }, newBests, mode: key };
}

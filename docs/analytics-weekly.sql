-- Human player-rounds, not unique people. QA rows are explicitly excluded.
-- The Analytics Engine _sample_interval weights must be retained.
SELECT
  blob2 AS mode,
  blob3 AS map_index,
  blob4 AS network,
  blob5 AS outcome,
  SUM(_sample_interval) AS player_rounds,
  SUM(_sample_interval * double1) AS active_seconds,
  SUM(_sample_interval * double2) AS round_clock_seconds,
  SUM(_sample_interval * double3) AS kills,
  SUM(_sample_interval * double4) AS deaths,
  SUM(_sample_interval * double5) AS spawn_deaths,
  SUM(_sample_interval * double6) AS assists,
  SUM(_sample_interval * double7) AS contribution,
  SUM(_sample_interval * double8) AS objective,
  SUM(_sample_interval * double9) AS shots,
  SUM(_sample_interval * double10) AS digs,
  SUM(_sample_interval * double11) AS placements,
  SUM(_sample_interval * double12) AS grenades,
  SUM(_sample_interval * double13) AS pings,
  SUM(_sample_interval * double14) AS airstrikes,
  SUM(_sample_interval * double17) AS rifle_seconds,
  SUM(_sample_interval * double18) AS smg_seconds,
  SUM(_sample_interval * double19) AS sniper_seconds
FROM spadefall_game_health
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND index1 = 'human_round'
  AND blob1 = 'human-v1'
GROUP BY blob2, blob3, blob4, blob5
ORDER BY player_rounds DESC

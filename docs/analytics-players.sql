-- Counts browser IDs that entered play, not page views or verified people.
-- IDs stay inside the database. Both grouping levels need LIMIT ALL.
SELECT
  count() AS retained_unique_browsers,
  sum(active_day) AS active_browsers_24h,
  sum(active_week) AS active_browsers_7d,
  sum(active_month) AS active_browsers_30d,
  sum(if(active_week = 1 AND previous_week = 1, 1, 0)) AS returning_from_previous_week,
  max(max_sample_interval) AS max_sample_interval
FROM (
  SELECT index1,
    max(if(timestamp >= NOW() - INTERVAL '1' DAY, 1, 0)) AS active_day,
    max(if(timestamp >= NOW() - INTERVAL '7' DAY, 1, 0)) AS active_week,
    max(if(timestamp >= NOW() - INTERVAL '30' DAY, 1, 0)) AS active_month,
    max(if(timestamp >= NOW() - INTERVAL '14' DAY AND timestamp < NOW() - INTERVAL '7' DAY, 1, 0)) AS previous_week,
    max(_sample_interval) AS max_sample_interval
  FROM spadefall_game_health
  WHERE blob1 = 'players-v1' AND blob2 = 'played'
  GROUP BY index1
  LIMIT ALL
)
LIMIT ALL

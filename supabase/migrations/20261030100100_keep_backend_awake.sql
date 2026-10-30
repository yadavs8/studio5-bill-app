-- The Render backend (free plan) falls asleep after ~15 idle minutes and then takes 30-60 s to
-- answer the first request, which is what makes the app feel stuck when it is opened.
-- Ping its /health route every 10 minutes during working hours, 07:30-22:30 IST
-- (02:00-16:59 UTC), about 465 hours a month, well inside the free plan's 750.
select cron.schedule('keep-render-backend-awake', '*/10 2-16 * * *', $job$
  select net.http_get('https://studio5-bill-backened.onrender.com/health', timeout_milliseconds := 60000);
$job$);

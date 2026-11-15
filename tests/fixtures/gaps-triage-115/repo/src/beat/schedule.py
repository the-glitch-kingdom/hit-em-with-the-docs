from celery.schedules import crontab

app.conf.beat_schedule = {
    'sweep_idle_rows': {'task': 'tasks.sweep_idle_rows', 'schedule': crontab(minute=0, hour=1)},
    'send_trial_series': {'task': 'tasks.send_trial_series', 'schedule': crontab(minute=0, hour=9)},
    'purge_signup_rows': {'task': 'tasks.purge_signup_rows', 'schedule': crontab(minute=30, hour=4)},
}

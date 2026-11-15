from celery.schedules import crontab

app.conf.beat_schedule = {
    'nightly_backup': {'task': 'tasks.nightly_backup', 'schedule': crontab(minute=0, hour=2)},
    'hourly_sync': {'task': 'tasks.hourly_sync', 'schedule': crontab(minute=0)},
    'weekly_digest': {'task': 'tasks.weekly_digest', 'schedule': crontab(minute=0, hour=8, day_of_week=1)},
}

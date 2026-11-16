from celery.schedules import crontab

app.conf.beat_schedule = {
    'rotate_logs': {'task': 'tasks.rotate_logs', 'schedule': crontab(minute=0, hour=3)},
    'rotate_reports': {'task': 'tasks.rotate_reports', 'schedule': crontab(minute=0, hour=5)},
    'rotate_audit': {'task': 'tasks.rotate_audit', 'schedule': crontab(minute=0, hour=6)},
}
ROTATE_KEEP_DAYS = 14

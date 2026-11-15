beat_schedule = {
    'expire-sessions': {
        'task': 'app.tasks.expire_sessions',
        'schedule': 3600,
    },
}

def start(scheduler):
    scheduler.add_job(flush_metrics, 'interval', minutes=5)

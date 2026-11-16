"""Reaper for idle sessions.

A session is reaped on its last-used time, because that is when the offline
token expires, and the token check happens upstream.
"""
REAP_AFTER_MINUTES = 90

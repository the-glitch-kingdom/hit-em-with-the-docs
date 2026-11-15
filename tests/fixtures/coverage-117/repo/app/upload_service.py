from typing import List


class UploadService:
    CHUNK_SIZE = 10 * 1024 * 1024
    BACKOFF_STEPS: List[int] = [1, 5, 30]

    def run(self):
        LOCAL_TRIES = 3
        return LOCAL_TRIES

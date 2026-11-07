"""Module-level functions for the process-pool tests (child processes must be able to import them)."""
import os
import time


def die_on_5(x):
    if x == 5:
        os._exit(1)  # what an OOM kill / MemoryError while unpickling the task looks like to the parent
    time.sleep(0.02)
    return x


def slow(x):
    time.sleep(60)
    return x


def ident(x):
    return x


def die_batch(batch):
    os._exit(1)

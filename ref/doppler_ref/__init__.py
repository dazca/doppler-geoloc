"""Reference implementation of Doppler-based geolocation from aircraft sound (Lane A)."""
from .geo import ENU
from .track import Track, load_tracks
from .doppler import (emission_time, received_freq, straight_line_f, straight_line_te, cpa,
                      speed_of_sound, AUDIBLE_R, C_DEFAULT)
from .spectrogram import spectrogram, whiten, bilinear, curve_score, as2d

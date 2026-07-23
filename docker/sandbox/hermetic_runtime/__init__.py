"""Hermetic sandbox runtime — the preloaded helper API for generated analysis code.

These are the TESTED, canonical versions of the helpers the prelude used to
define inline (see spec/skills-and-custom-modules-2026-07-22.md Phase 2). The
package is shipped into the container per-run as /data/hermetic_runtime/ and
imported by the prelude, which keeps its inline copies for one release as a
fallback only.

Import-time side effects are forbidden here: the prelude imports this before
user code runs, and a crash on import would take down every analysis.
"""

from . import guards
from .coerce import safe_float, safe_int, to_native
from .frames import numeric, safe_qcut, to_num
from .guards import assert_fits
from .output import write_output

__all__ = [
    "assert_fits",
    "guards",
    "numeric",
    "safe_float",
    "safe_int",
    "safe_qcut",
    "to_native",
    "to_num",
    "write_output",
]

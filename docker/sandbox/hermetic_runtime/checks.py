"""declare_check — model-authored validation as findings (declared-checks spec).

A check is a finding ABOUT the data or the analysis process: dtype "check",
tags ["check", severity], value {"passed": bool|None, **evidence}. It rides
the entire findings channel (validation, caps, lineage, binding, UI, MCP)
with zero new plumbing. Never raises.
"""
from .findings import declare_finding


def declare_check(name, definition, passed=None, evidence=None,
                  severity="caveat", derived_from_columns=None):
    try:
        sev = severity if severity in ("caveat", "blocking") else "caveat"
        value = {"passed": None if passed is None else bool(passed)}
        if isinstance(evidence, dict):
            for k, v in evidence.items():
                if k != "passed":
                    value[str(k)] = v
        declare_finding(
            name,
            value,
            definition=definition,
            dtype="check",
            tags=["check", sev],
            derived_from_columns=derived_from_columns,
            _frame_depth=2,
        )
    except Exception:
        pass

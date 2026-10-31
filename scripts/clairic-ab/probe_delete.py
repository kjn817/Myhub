#!/usr/bin/env python3
"""Delete the Clairic A/B scratch probe Worker and verify it is gone."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / ".scratch"))
from cfapi import call  # noqa: E402

NAME = "clairic-ab-probe-20261028"
AID = "59e749ed2e9cdb8b0bf70d47227968a1"


def main() -> int:
    st, r = call("DELETE", f"/accounts/{AID}/workers/scripts/{NAME}")
    print(f"DELETE: {st} {json.dumps(r)[:300]}")
    st, r = call("GET", f"/accounts/{AID}/workers/scripts/{NAME}")
    print(f"GET after delete: {st} {json.dumps(r)[:300]}")
    if st == 404:
        print("VERIFIED: probe worker deleted")
        return 0
    print("WARNING: probe worker may still exist", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

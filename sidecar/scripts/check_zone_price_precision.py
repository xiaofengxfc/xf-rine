"""Regression check for low-priced support/resistance zone serialization."""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.sr_engine import Calibration, SREngine
from src.srlab.probability import ProbabilityModels


def main() -> None:
    zone = SimpleNamespace(
        center=0.00001234,
        low=0.00001123,
        high=0.00001345,
        kind="support",
        score=0.7,
        dist_pct=-1.0,
        dist_atr=-1.5,
        width_atr=0.2,
        meta={},
    )
    result = SREngine()._zone_json(
        zone,
        atr=0.000001,
        price=0.0000125,
        calib=Calibration(path="missing-calibration.json"),
        probs=ProbabilityModels(path="missing-models.json"),
    )

    expected = {"center": 0.00001234, "low": 0.00001123, "high": 0.00001345}
    for field, value in expected.items():
        assert result[field] == value, f"{field} lost precision: {result[field]}"

    print("low-priced zone prices preserve precision")


if __name__ == "__main__":
    main()

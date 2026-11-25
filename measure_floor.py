"""量測 noise floor：python measure_floor.py 檔案1.xlsx [檔案2.xlsx ...]"""
import sys
from pathlib import Path

import numpy as np

from backend.excel_loader import ExcelSource, read_excel
from backend.training import hit_ceiling, is_valid, noise_floor

paths = [Path(arg) for arg in sys.argv[1:]]
if not paths:
    sys.exit("用法：python measure_floor.py 檔案1.xlsx [檔案2.xlsx ...]")

sources = [ExcelSource(i, path.name, path) for i, path in enumerate(paths, start=1)]
balls, counts = read_excel(sources, lambda *args, **kwargs: None)
balls = [ball for ball in balls if is_valid(ball.landing)]

features = np.asarray([ball.parameters for ball in balls], dtype=int)
coordinates = np.asarray([ball.landing for ball in balls], dtype=int)
_, sizes = np.unique(features, axis=0, return_counts=True)
floor = noise_floor(features, coordinates)

decided = counts["valid_balls"] + counts["invalid_balls"]
print(f"有效球 {counts['valid_balls']}、無效球 {counts['invalid_balls']}"
      f"（無效比例 {counts['invalid_balls'] / decided:.1%}）、缺測 {counts['missing_balls']}")
print(f"四參數組數 {len(sizes)}，其中有效球 ≥2 的組 {int((sizes >= 2).sum())}")
for column, axis in enumerate("xy"):
    total_var = float(np.var(coordinates[:, column]))   # 全體變異 ≈ baseline MSE
    f = floor[axis]
    print(f"{axis.upper()} 軸：floor MSE = {f:.4f}（RMSE ≈ {f ** 0.5:.2f} 格）｜"
          f"全體變異 = {total_var:.4f}｜最多可解釋 ≈ {1 - f / total_var:.0%}")
ceiling = hit_ceiling(features, coordinates)
print(f"整球精準命中上限（粗估，略偏樂觀）≈ {ceiling:.0%}")
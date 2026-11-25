"""使用有效落點進行分組五折驗證、選模與正式重訓。"""

import warnings
from collections import Counter
from math import hypot, sqrt
from statistics import mean

import numpy as np
from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor
from sklearn.metrics import mean_squared_error
from sklearn.model_selection import GroupKFold, StratifiedGroupKFold

from .excel_loader import PARAMETERS, PARAMETER_KEYS


FOLDS = "ABCDE"
TREE_COUNT = 500
RANDOM_SEED = 42
ALGORITHMS = {"RF": RandomForestRegressor, "ET": ExtraTreesRegressor}
CANDIDATES = {
    f"{algorithm}{axis}": (algorithm, column)
    for column, axis in enumerate("xy")
    for algorithm in ALGORITHMS
}
REPORT_NOTE = (
    "五折成績來自各折留出的球，同一套五折也用於選模。"
    "正式 X、Y 模型用本批全部有效球重訓，正式模型的表現由另備的獨立測試資料評估。"
)


class TrainingError(ValueError):
    pass


def is_valid(landing):
    return all(1 <= coordinate <= 5 for coordinate in landing)


def noise_floor(features, coordinates):
    """同一組四參數內的落點變異 = MSE 的理論下限（不可約誤差）。"""
    _, groups = np.unique(features, axis=0, return_inverse=True)
    groups = groups.ravel()
    group_count = len(np.bincount(groups))
    floor = {}
    for column, axis in enumerate("xy"):
        y = coordinates[:, column].astype(float)
        group_mean = np.bincount(groups, weights=y) / np.bincount(groups)
        ssw = ((y - group_mean[groups]) ** 2).sum()
        dof = len(y) - group_count  # 自由度：球數 − 組數
        floor[axis] = float(ssw / dof) if dof > 0 else None
    return floor


def hit_ceiling(features, coordinates):
    """每組都猜最常出現的那一格時，能命中的比例（粗略上界，略偏樂觀）。"""
    _, groups = np.unique(features, axis=0, return_inverse=True)
    groups = groups.ravel()
    hit = total = 0
    for group in np.unique(groups):
        rows = coordinates[groups == group]
        if len(rows) < 2:  # 只有 1 球的組不算
            continue
        hit += max(Counter(map(tuple, rows)).values())
        total += len(rows)
    return hit / total if total else None


def make_folds(features, coordinates):
    settings, groups = np.unique(features, axis=0, return_inverse=True)
    groups = groups.ravel()
    if len(settings) < len(FOLDS):
        raise TrainingError("五折驗證至少需要五組不同的有效四參數設定。")
    # X、Y 實測值仍分別作為迴歸目標。合成的格號只用於分層。
    landing_classes = (coordinates[:, 1] - 1) * 5 + coordinates[:, 0]
    options = dict(n_splits=len(FOLDS), shuffle=True, random_state=RANDOM_SEED)

    def split(splitter):
        method = type(splitter).__name__
        try:
            return list(splitter.split(features, landing_classes, groups))
        except Exception as error:
            raise TrainingError(f"{method} 切分失敗（{type(error).__name__}: {error}）。") from error

    split_warnings = []
    fallback_reason = None
    max_balls_in_cell = max(Counter(landing_classes).values())
    method = "StratifiedGroupKFold"
    if max_balls_in_cell < len(FOLDS):
        fallback_reason = f"單格最大球數為 {max_balls_in_cell}，少於五顆。"
    else:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", UserWarning)
            folds = split(StratifiedGroupKFold(**options))
        split_warnings = [str(warning.message) for warning in caught]
        try:
            validate_folds(folds, groups)
        except TrainingError as error:
            fallback_reason = f"StratifiedGroupKFold 切分未通過驗證。{error}"

    if fallback_reason is not None:
        method = "GroupKFold"
        folds = split(GroupKFold(**options))
        try:
            validate_folds(folds, groups)
        except TrainingError as error:
            raise TrainingError(f"GroupKFold 切分未通過驗證。{error}") from error

    return folds, {
        "method": method,
        "warnings": split_warnings,
        "fallback_reason": fallback_reason,
        "folds": {
            fold: {
                "training_balls": len(training),
                "validation_balls": len(validation),
                "training_groups": int(np.unique(groups[training]).size),
                "validation_groups": int(np.unique(groups[validation]).size),
            }
            for fold, (training, validation) in zip(FOLDS, folds, strict=True)
        },
    }


def validate_folds(folds, groups):
    if len(folds) != len(FOLDS):
        raise TrainingError(f"預期五折，實際取得 {len(folds)} 折。")
    seen = np.zeros(len(groups), dtype=int)
    for fold, (training, validation) in zip(FOLDS, folds, strict=True):
        if not len(training) or not len(validation):
            raise TrainingError(f"{fold} 折缺少訓練或驗證資料。")
        if np.intersect1d(groups[training], groups[validation]).size:
            raise TrainingError(f"{fold} 折的訓練集和驗證集出現同一組四參數。")
        np.add.at(seen, validation, 1)
    if not np.all(seen == 1):
        raise TrainingError("每顆有效球須恰好被驗證一次。")


def summarize_data(balls, features, coordinates):
    cells = Counter(ball.landing for ball in balls)
    groups = {cell: set() for cell in cells}
    for ball in balls:
        groups[ball.landing].add(ball.parameters)

    grid = []
    unobserved = []
    sparse = []
    for y in range(1, 6):
        row = []
        for x in range(1, 6):
            cell = (x, y)
            counts = {"balls": cells[cell], "groups": len(groups.get(cell, ()))}
            row.append(counts)
            if not counts["balls"]:
                unobserved.append([x, y])
            elif counts["groups"] < len(FOLDS):
                sparse.append({"x": x, "y": y, **counts})
        grid.append(row)

    labels = [label for _, label, _ in PARAMETERS] + ["實測 X", "實測 Y"]
    columns = np.column_stack((features, coordinates))
    varying = np.flatnonzero(np.any(columns != columns[0], axis=0))
    matrix = [[None for _ in labels] for _ in labels]
    if varying.size == 1:
        index = varying[0]
        matrix[index][index] = 1.0
    elif varying.size > 1:
        correlations = np.corrcoef(columns[:, varying], rowvar=False)
        for row, i in enumerate(varying):
            for column, j in enumerate(varying):
                matrix[i][j] = 1.0 if i == j else float(correlations[row, column])

    return {
        "x_counts": [sum(row[x]["balls"] for row in grid) for x in range(5)],
        "y_counts": [sum(cell["balls"] for cell in row) for row in grid],
        "grid": grid,
        "unobserved_cells": unobserved,
        "min_observed_balls": min(cells.values()),
        "sparse_cells": sparse,
        "pearson": {"labels": labels, "matrix": matrix},
    }


def make_model(algorithm):
    return ALGORITHMS[algorithm](
        n_estimators=TREE_COUNT,
        max_features=2,
        max_depth=None,
        bootstrap=algorithm == "RF",
        random_state=RANDOM_SEED,
    )


def landing_errors(actual, predicted):
    dx = float(predicted[0] - actual[0])
    dy = float(predicted[1] - actual[1])
    return {"dx": dx, "dy": dy, "distance": hypot(dx, dy)}


def evaluate(records, x_key="predicted_x", y_key="predicted_y"):
    """以同一批球逐球同權計算兩軸及整球誤差。"""
    errors = [
        landing_errors(
            (record["actual_x"], record["actual_y"]),
            (record[x_key], record[y_key]),
        )
        for record in records
    ]
    metrics = {"balls": len(errors)}
    for axis in "xy":
        differences = [error[f"d{axis}"] for error in errors]
        mse = mean(difference ** 2 for difference in differences)
        metrics[axis] = {"mae": mean(map(abs, differences)), "mse": mse, "rmse": sqrt(mse)}
    metrics["mean_distance"] = mean(error["distance"] for error in errors)
    metrics["rmse_distance"] = sqrt(metrics["x"]["mse"] + metrics["y"]["mse"])
    return metrics


def validation_record(ball, fold, predictions, winners):
    x, y = (predictions[winners[axis]] for axis in "xy")
    return {
        "ball_id": ball.ball_id,
        "file_id": ball.file_id,
        "filename": ball.filename,
        "sheet": ball.sheet,
        "excel_row": ball.row,
        "test_id": ball.test_id,
        "serve": ball.serve,
        **dict(zip(PARAMETER_KEYS, ball.parameters, strict=True)),
        "raw_landing": ball.raw_landing,
        "fold": fold,
        "actual_x": ball.landing[0],
        "actual_y": ball.landing[1],
        **{name: predictions[name] for name in CANDIDATES},
        "predicted_x": x,
        "predicted_y": y,
        "baseline_x": predictions["baseline_x"],
        "baseline_y": predictions["baseline_y"],
        **landing_errors(ball.landing, (x, y)),
    }


def train(balls, counts, run_id, progress):
    balls = [ball for ball in balls if is_valid(ball.landing)]
    counts = {
        **counts, "training_balls": len(balls),
        "training_groups": len({ball.parameters for ball in balls}),
    }
    progress("analyzing", "逐球篩選並分析有效落點", counts=counts)
    if not balls:
        raise TrainingError("無有效球可訓練。")
    if counts["training_groups"] < len(FOLDS):
        raise TrainingError("五折驗證至少需要五組不同的有效四參數設定。")
    ball_ids = [ball.ball_id for ball in balls]
    if len(set(ball_ids)) != len(ball_ids):
        raise TrainingError("逐球紀錄包含重複的唯一球號。")

    features = np.asarray([ball.parameters for ball in balls], dtype=int)
    coordinates = np.asarray([ball.landing for ball in balls], dtype=int)
    summary = summarize_data(balls, features, coordinates)
    progress("splitting", "建立 A～E 五折")
    folds, split = make_folds(features, coordinates)

    baseline_names = ("baseline_x", "baseline_y")
    scores = {name: {} for name in (*CANDIDATES, *baseline_names)}
    predictions = {name: {} for name in scores}
    fold_by_id = {}
    completed = 0
    for fold, (training, validation) in zip(FOLDS, folds, strict=True):
        ids = [ball_ids[index] for index in validation]
        fold_by_id.update(dict.fromkeys(ids, fold))
        for column, name in enumerate(baseline_names):
            average = float(coordinates[training, column].mean())
            estimates = [average] * len(validation)
            scores[name][fold] = float(mean_squared_error(coordinates[validation, column], estimates))
            predictions[name].update(dict.fromkeys(ids, average))
        for name, (algorithm, column) in CANDIDATES.items():
            progress("cross_validation", f"{fold} 折 {name}", fold=fold, model=name, completed=completed, total=20)
            model = make_model(algorithm).fit(features[training], coordinates[training, column])
            estimates = model.predict(features[validation])
            scores[name][fold] = float(mean_squared_error(coordinates[validation, column], estimates))
            predictions[name].update(zip(ids, map(float, estimates), strict=True))
            completed += 1

    progress("evaluating", "選出 X、Y 模型並計算整批評估", completed=20, total=20)
    selection = {
        name: {"folds": fold_scores, "mean": mean(fold_scores.values())}
        for name, fold_scores in scores.items()
    }
    winners = {
        axis: min((f"RF{axis}", f"ET{axis}"), key=lambda name: selection[name]["mean"])
        for axis in "xy"
    }
    records = [
        validation_record(
            ball, fold_by_id[ball.ball_id],
            {name: by_id[ball.ball_id] for name, by_id in predictions.items()},
            winners,
        )
        for ball in balls
    ]

    models = {}
    for column, axis in enumerate("xy"):
        winner = winners[axis]
        progress("refitting", f"重訓 {axis.upper()} 軸 {winner}", model=winner, completed=column, total=2)
        models[axis] = make_model(CANDIDATES[winner][0]).fit(features, coordinates[:, column])
    return models, records, {
        "run_id": run_id,
        "data": counts,
        "data_summary": summary,
        "split": split,
        "selection": selection,
        "winners": winners,
        "evaluation": evaluate(records),
        "baseline_evaluation": evaluate(records, "baseline_x", "baseline_y"),
        "note": REPORT_NOTE,
    }

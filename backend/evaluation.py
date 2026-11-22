"""用已發布的 X、Y 模型評估一份獨立測試活頁簿。"""

from .excel_loader import DataError, read_excel
from .training import evaluate, is_valid


def evaluate_test_workbook(published, source):
    """對每顆有效實測球評分，並保留原始的球位統計。"""
    balls, counts = read_excel([source], lambda *args: None)
    balls = [ball for ball in balls if is_valid(ball.landing)]
    ball_counts = {
        key: counts[key] for key in ("valid_balls", "invalid_balls", "missing_balls")
    }
    if not balls:
        raise DataError("無有效球可評估", counts=ball_counts)

    features = list(dict.fromkeys(ball.parameters for ball in balls))
    predicted_x = published.models["x"].predict(features)
    predicted_y = published.models["y"].predict(features)
    by_parameters = {
        parameters: (float(x), float(y))
        for parameters, x, y in zip(features, predicted_x, predicted_y, strict=True)
    }
    records = [
        {
            "actual_x": ball.landing[0], "actual_y": ball.landing[1],
            "predicted_x": by_parameters[ball.parameters][0],
            "predicted_y": by_parameters[ball.parameters][1],
        }
        for ball in balls
    ]
    return {
        "run_id": published.run_id,
        "filename": source.filename,
        "counts": ball_counts,
        "evaluation": evaluate(records),
    }

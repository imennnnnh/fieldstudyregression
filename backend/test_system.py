"""驗證實測資料解析、模型評分與服務 API。"""

import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import numpy as np
from openpyxl import Workbook

from .app import compare_landing, create_app
from .excel_loader import EXCEL_HEADERS, DataError, ExcelSource, parse_integer, read_excel
from .storage import PublishedRun, read_json, save_uploads, write_json
from .training import TrainingError, evaluate, landing_errors, make_folds, make_model, train


RUNTIME = Path(__file__).resolve().parent.parent / "runtime"


def workbook_bytes(rows, extra_sheets=None):
    """以指定資料列建立記憶體中的 Excel 測試檔。"""
    workbook = Workbook()
    workbook.active.title = "實測"
    for sheet, data in {"實測": rows, **(extra_sheets or {})}.items():
        target = workbook.active if sheet == "實測" else workbook.create_sheet(sheet)
        for row in data:
            target.append(row)
    stream = io.BytesIO()
    workbook.save(stream)
    workbook.close()
    return stream.getvalue()


class DataTests(unittest.TestCase):
    """涵蓋 Excel 格式、資料類型及逐球展開規則。"""

    def setUp(self):
        RUNTIME.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def source(self, number, contents):
        """將測試 Excel 放進此案例的暫存目錄。"""
        path = self.directory / f"{number}.xlsx"
        path.write_bytes(contents)
        return ExcelSource(number, "同名.xlsx", path)

    def test_expansion_keeps_source_and_repeats(self):
        """確認重複資料有各自的球號，並可追溯來源。"""
        row = ("A", "13.0", 2, 3, 4, "(1, 2)", "(1,2)", "未過網", None, "(0,3)")
        data = workbook_bytes(
            [(*EXCEL_HEADERS, "補測順位"), ("預填",), row, row,
             ("全缺測", 1, 2, 3, 4, "(0,0)", "無效球", "（1，2）")],
            {"補測": [EXCEL_HEADERS, row], "說明": [("項目", "內容")]},
        )
        balls, counts = read_excel([self.source(n, data) for n in (1, 2)], lambda *args: None)
        self.assertEqual(len(balls), 18)
        self.assertEqual(len({ball.ball_id for ball in balls}), 18)
        self.assertEqual(balls[0].row, 3)
        self.assertEqual(balls[0].parameters, (13, 2, 3, 4))
        self.assertEqual(balls[0].test_id, "A")
        self.assertEqual([ball.landing for ball in balls[:3]], [(1, 2), (1, 2), (0, 0)])
        self.assertEqual(
            [
                counts[name]
                for name in ("total_balls", "valid_balls", "invalid_balls", "missing_balls")
            ],
            [40, 12, 6, 22],
        )
        self.assertEqual(counts["sources"][0]["sheets"], ["實測", "補測"])
        self.assertNotIn("training_balls", counts)
        self.assertNotIn("training_groups", counts)

    def test_invalid_parameter_even_if_all_landings_are_missing(self):
        """確認落點全缺測的資料列仍會檢查四參數。"""
        data = workbook_bytes([EXCEL_HEADERS, ("A", 13.5, 2, 3, 4)])
        with self.assertRaises(DataError) as failure:
            read_excel([self.source(1, data)], lambda *args: None)
        self.assertEqual(failure.exception.details, {
            "file": "同名.xlsx", "sheet": "實測", "row": 2, "field": "仰角角度", "raw_value": "13.5",
        })

    def test_every_file_needs_a_qualified_sheet(self):
        """確認每份檔案至少有一張格式正確的工作表。"""
        good = self.source(1, workbook_bytes([EXCEL_HEADERS]))
        bad = self.source(2, workbook_bytes([("說明",)]))
        with self.assertRaisesRegex(DataError, "找不到"):
            read_excel([good, bad], lambda *args: None)
        with self.assertRaisesRegex(DataError, "無法讀取"):
            read_excel([good, self.source(3, b"invalid xlsx")], lambda *args: None)

    def test_integer_validation(self):
        """檢查等於整數的數字可用，其他輸入會被拒絕。"""
        for accepted in (13, 13.0, " 13.00 ", "1.3e1"):
            self.assertEqual(parse_integer(accepted, "仰角", 28), 13)
        for rejected in (True, None, 13.5, "13.000000000000001", "NaN", "", 29, 0):
            with self.subTest(rejected=rejected), self.assertRaises(DataError):
                parse_integer(rejected, "仰角", 28)


class ModelTests(unittest.TestCase):
    def splits_for(self, first_groups, second_groups, repeats=1):
        features = np.asarray([
            [group, 2, 3, 4] for group in range(1, first_groups + second_groups + 1)
            for _ in range(repeats)
        ])
        coordinates = np.asarray([(1, 2)] * first_groups * repeats + [(5, 4)] * second_groups * repeats)
        folds, meta = make_folds(features, coordinates)
        self.assertEqual(len(folds), 5)
        seen = []
        for label, (training, validation) in zip("ABCDE", folds, strict=True):
            train_groups = {tuple(row) for row in features[training]}
            val_groups = {tuple(row) for row in features[validation]}
            self.assertTrue(train_groups.isdisjoint(val_groups))
            self.assertEqual(meta["folds"][label], {
                "training_balls": len(training), "validation_balls": len(validation),
                "training_groups": len(train_groups), "validation_groups": len(val_groups),
            })
            seen.extend(validation.tolist())
        self.assertEqual(sorted(seen), list(range(len(features))))
        return meta

    def test_stratified_fold_keeps_sparse_warning(self):
        split = self.splits_for(10, 1)
        self.assertEqual(split["method"], "StratifiedGroupKFold")
        self.assertTrue(split["warnings"])
        self.assertIsNone(split["fallback_reason"])

    def test_small_cells_use_group_kfold(self):
        with patch("backend.training.StratifiedGroupKFold") as stratified:
            split = self.splits_for(4, 4)
        stratified.assert_not_called()
        self.assertEqual(split["method"], "GroupKFold")
        self.assertIn("單格最大球數為 4", split["fallback_reason"])

    def test_sparse_group_coverage_does_not_trigger_fallback(self):
        rows = [EXCEL_HEADERS] + [
            ("測試", n, 2, 3, 4, "(1,2)", "(1,2)") if n <= 3 else
            ("測試", n, 2, 3, 4, "(5,4)", "(5,4)")
            for n in range(1, 7)
        ]
        balls, counts = read_excel(
            [ExcelSource(1, "組數不足.xlsx", io.BytesIO(workbook_bytes(rows)))], lambda *args: None,
        )
        with patch("backend.training.TREE_COUNT", 2):
            _, _, report = train(balls, counts, "test", lambda *args, **kwargs: None)
        self.assertEqual(report["split"]["method"], "StratifiedGroupKFold")
        self.assertIsNone(report["split"]["fallback_reason"])
        summary = report["data_summary"]
        self.assertEqual(summary["sparse_cells"], [
            {"x": 1, "y": 2, "balls": 6, "groups": 3},
            {"x": 5, "y": 4, "balls": 6, "groups": 3},
        ])
        self.assertEqual(summary["grid"][1][0], {"balls": 6, "groups": 3})
        self.assertEqual(summary["grid"][3][4], {"balls": 6, "groups": 3})
        self.assertEqual(summary["grid"][0][0], {"balls": 0, "groups": 0})
        self.assertEqual(summary["x_counts"], [6, 0, 0, 0, 6])
        self.assertEqual(summary["y_counts"], [0, 6, 0, 6, 0])
        self.assertEqual(len(summary["unobserved_cells"]), 23)
        self.assertEqual(summary["min_observed_balls"], 6)

    def test_invalid_stratified_folds_fall_back_and_validate(self):
        invalid = [(np.array([0]), np.array([], dtype=int))] * 5
        with patch("backend.training.StratifiedGroupKFold.split", return_value=iter(invalid)):
            split = self.splits_for(6, 6)
        self.assertEqual(split["method"], "GroupKFold")
        self.assertIn("A 折缺少訓練或驗證資料", split["fallback_reason"])
        with patch("backend.training.GroupKFold.split", return_value=iter(invalid)):
            with self.assertRaisesRegex(TrainingError, "GroupKFold 切分未通過驗證"):
                self.splits_for(4, 4)

    def test_unexpected_split_failure_keeps_reason(self):
        with (
            patch("backend.training.StratifiedGroupKFold.split", side_effect=ValueError("split failure")),
            patch("backend.training.GroupKFold") as backup,
        ):
            with self.assertRaisesRegex(TrainingError, "ValueError: split failure"):
                self.splits_for(6, 6)
        backup.assert_not_called()

    def test_model_settings(self):
        for algorithm, name in (("RF", "RandomForestRegressor"), ("ET", "ExtraTreesRegressor")):
            model = make_model(algorithm)
            self.assertEqual(type(model).__name__, name)
            settings = model.get_params()
            self.assertEqual(settings["n_estimators"], 500)
            self.assertEqual(settings["random_state"], 42)
            self.assertEqual(settings["max_features"], 2)
            self.assertIsNone(settings["max_depth"])
            self.assertEqual(settings["bootstrap"], algorithm == "RF")
            self.assertIsNone(settings["max_samples"])
            self.assertIsNone(settings["n_jobs"])

    def test_baseline_uses_training_means_and_rf_wins_ties(self):
        rows = [EXCEL_HEADERS] + [
            ("測試", group, 2, 3, 4, f"({group},2)") for group in range(1, 6)
        ]
        balls, counts = read_excel(
            [ExcelSource(1, "基準線.xlsx", io.BytesIO(workbook_bytes(rows)))], lambda *args: None,
        )
        fitted = []

        class MeanModel:
            def fit(self, features, target):
                self.value = float(target.mean())
                fitted.append((len(features), self.value))
                return self

            def predict(self, features):
                return [self.value] * len(features)

        with patch("backend.training.make_model", side_effect=lambda algorithm: MeanModel()):
            _, records, report = train(balls, counts, "test", lambda *args, **kwargs: None)
        self.assertEqual(report["winners"], {"x": "RFx", "y": "RFy"})
        self.assertEqual([count for count, _ in fitted], [4] * 20 + [5, 5])
        self.assertEqual(report["selection"]["RFx"], report["selection"]["baseline_x"])
        self.assertEqual(report["selection"]["RFy"], report["selection"]["baseline_y"])
        self.assertEqual(report["evaluation"], report["baseline_evaluation"])
        for record in records:
            self.assertEqual(record["baseline_x"], (15 - record["actual_x"]) / 4)
            self.assertEqual(record["baseline_y"], 2.0)

    def test_errors_and_fold_weighting(self):
        folds = [[{
            "actual_x": 2, "actual_y": 3, "predicted_x": x, "predicted_y": 4,
        }] * count for x, count in ((3, 1), (3, 1), (3, 1), (3, 1), (4, 6))]
        self.assertAlmostEqual(sum(evaluate(fold)["x"]["mse"] for fold in folds) / 5, 1.6)
        pooled = evaluate([record for fold in folds for record in fold])
        self.assertAlmostEqual(pooled["x"]["mse"], 2.8)
        self.assertAlmostEqual(pooled["y"]["mse"], 1.0)
        self.assertAlmostEqual(pooled["rmse_distance"], 3.8 ** 0.5)
        errors = landing_errors((2, 3), (2.6, 4.0))
        self.assertAlmostEqual(errors["dx"], 0.6)
        self.assertEqual(errors["dy"], 1.0)
        self.assertAlmostEqual(errors["distance"], 1.36 ** 0.5)
        self.assertIsNone(compare_landing((2.6, 4.0), None))
        self.assertEqual(compare_landing((2.6, 4.0), (0, 0))["message"], "實測為無效球，無座標可比對")


async def request(app, method, path, *, body=b"", content_type=b"application/json"):
    """直接送出 ASGI 請求，收集 HTTP 狀態與 JSON。"""
    messages = []

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        messages.append(message)

    await app({
        "type": "http", "asgi": {"version": "3.0"}, "method": method,
        "path": path, "root_path": "", "query_string": b"",
        "headers": [(b"content-type", content_type)],
    }, receive, send)
    return messages[0]["status"], json.loads(messages[-1]["body"])


def multipart(files):
    """產生 API 測試所需的 multipart 上傳內容。"""
    boundary = b"TableTennisTestBoundary"
    parts = []
    for name, contents in files:
        parts.append(
            b"--" + boundary + b'\r\nContent-Disposition: form-data; name="files"; filename="' +
            name.encode("utf-8") + b'"\r\n\r\n' + contents + b"\r\n"
        )
    return {
        "body": b"".join(parts) + b"--" + boundary + b"--\r\n",
        "content_type": b"multipart/form-data; boundary=" + boundary,
    }

class APITests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        RUNTIME.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    async def test_independent_evaluation(self):
        class FixedAxis:
            def __init__(self, value):
                self.value = value

            def predict(self, features):
                return [self.value] * len(features)

        app = create_app(self.root)
        endpoint = "/api/evaluation"
        report = {"run_id": "test-run", "winners": {"x": "RFx", "y": "ETy"}}
        rows = [EXCEL_HEADERS, ("A", 1, 2, 3, 4, "未過網", "(2,3)")]
        files = [("獨立測試.xlsx", workbook_bytes(rows))]
        async with app.router.lifespan_context(app):
            self.assertEqual(await request(app, "POST", endpoint), (409, {"error": "請先完成訓練"}))
            app.state.published = PublishedRun(report, {"x": FixedAxis(2.6), "y": FixedAxis(4.0)})
            with (
                patch("backend.app.train", side_effect=AssertionError("評估進入了訓練")),
                patch("backend.app.save_uploads", side_effect=AssertionError("評估發布了訓練檔")),
                patch("backend.app.publish", side_effect=AssertionError("評估發布了模型")),
            ):
                status, result = await request(app, "POST", endpoint, **multipart(files))
                self.assertEqual(status, 200)
                self.assertEqual(result["run_id"], "test-run")
                self.assertEqual(result["filename"], "獨立測試.xlsx")
                self.assertEqual(result["counts"], dict(valid_balls=1, invalid_balls=1, missing_balls=3))
                self.assertEqual(result["evaluation"]["balls"], 1)
                for key, expected in (("mae", 0.6), ("mse", 0.36), ("rmse", 0.6)):
                    self.assertAlmostEqual(result["evaluation"]["x"][key], expected)
                    self.assertAlmostEqual(result["evaluation"]["y"][key], 1.0)
                for metric in ("mean_distance", "rmse_distance"):
                    self.assertAlmostEqual(result["evaluation"][metric], 1.36 ** 0.5)
                self.assertEqual(await request(app, "GET", "/api/reports/latest"), (200, report))
                status, prediction = await request(
                    app, "POST", "/api/predict",
                    body=b'{"angle":1,"position":2,"spin":3,"strength":4,"measured":{"status":"valid","x":2,"y":3}}',
                )
                self.assertEqual((status, prediction["x"], prediction["y"]), (200, 2.6, 4.0))
                self.assertIsInstance(prediction["y"], float)
                self.assertAlmostEqual(prediction["comparison"]["absolute_error_x"], 0.6)
                self.assertEqual(prediction["comparison"]["absolute_error_y"], 1.0)
                self.assertAlmostEqual(prediction["comparison"]["distance"], 1.36 ** 0.5)
                self.assertEqual((await request(app, "POST", endpoint, **multipart(files * 2)))[0], 400)

            def evaluate_during_publication(published, _source):
                app.state.published = PublishedRun({"run_id": "new-run"}, {})
                return {"run_id": published.run_id}

            with patch("backend.app.evaluate_test_workbook", side_effect=evaluate_during_publication):
                self.assertEqual(
                    await request(app, "POST", endpoint, **multipart(files)),
                    (409, {"error": "正式模型已更新，請重新執行獨立測試。"}),
                )

    async def test_zero_valid_evaluation_reports_counts(self):
        app = create_app(self.root)
        async with app.router.lifespan_context(app):
            app.state.published = PublishedRun({"run_id": "test-run"}, {})
            for invalid_count in (5, 0, 3):
                with self.subTest(invalid_count=invalid_count):
                    rows = [EXCEL_HEADERS, ("A", 1, 2, 3, 4, *(["未過網"] * invalid_count))]
                    files = [("零顆有效球.xlsx", workbook_bytes(rows))]
                    self.assertEqual(
                        await request(app, "POST", "/api/evaluation", **multipart(files)),
                        (422, {"error": "無有效球可評估", "counts": {
                            "valid_balls": 0, "invalid_balls": invalid_count,
                            "missing_balls": 5 - invalid_count,
                        }}),
                    )
            missing_header = [("格式錯誤.xlsx", workbook_bytes([("測試編號",)]))]
            status, error = await request(app, "POST", "/api/evaluation", **multipart(missing_header))
            self.assertEqual((status, error["file"]), (422, "格式錯誤.xlsx"))
            self.assertIn("找不到包含 10 個必要欄位", error["error"])

    async def test_zero_valid_and_too_few_groups_report_counts(self):
        app = create_app(self.root)
        async with app.router.lifespan_context(app):
            for landing, expected, message in [
                ("未過網", (0, 0), "無有效球可訓練"),
                ("(2,3)", (2, 1), "至少需要五組"),
            ]:
                rows = [EXCEL_HEADERS, ("A", 1, 2, 3, 4, landing, landing)]
                files = [("有效設定不足.xlsx", workbook_bytes(rows))]
                self.assertEqual((await request(app, "POST", "/api/training", **multipart(files)))[0], 202)
                await app.state.task
                status, job = await request(app, "GET", "/api/training/status")
                self.assertEqual((status, job["task_type"], job["status"]), (200, "regression", "failed"))
                self.assertIn(message, job["message"])
                counts = job["counts"]
                self.assertEqual((counts["training_balls"], counts["training_groups"]), expected)
                self.assertEqual((counts["valid_balls"], counts["missing_balls"]), (expected[0], 3))

    async def test_old_report_and_states_are_ignored(self):
        artifacts = self.root / "artifacts"
        run_id = str(uuid4())
        bundle = artifacts / run_id
        bundle.mkdir(parents=True)
        status_path = artifacts / "training_status.json"
        write_json(artifacts / "latest_success.json", {"run_id": run_id})
        write_json(bundle / "report.json", {"run_id": run_id, "obsolete_format": True})
        save_uploads(self.root, run_id, [("舊分類.xlsx", io.BytesIO(b"old data"))])
        for status in ("completed", "failed", "running", "uploading"):
            with self.subTest(status=status):
                write_json(status_path, {
                    "run_id": run_id, "status": status, "phase": status, "message": "舊分類任務訊息",
                })
                app = create_app(self.root)
                with (
                    patch("backend.storage.joblib.load") as load,
                    self.assertLogs("backend.storage", level="INFO") as info,
                ):
                    async with app.router.lifespan_context(app):
                        _, job = await request(app, "GET", "/api/training/status")
                        self.assertEqual((job["status"], job["message"], job["uploaded_files"]), ("idle", "", []))
                        self.assertIsNone(job["latest_success_run_id"])
                        self.assertEqual((await request(app, "GET", "/api/reports/latest"))[0], 404)
                    load.assert_not_called()
                self.assertEqual(len(info.output), 1)
        rows = [EXCEL_HEADERS] + [("新資料", angle, 2, 3, 4, "(1,2)") for angle in range(1, 6)]
        app = create_app(self.root)
        async with app.router.lifespan_context(app):
            with self.assertNoLogs("backend.app", level="ERROR"), patch("backend.training.TREE_COUNT", 2):
                status, new_job = await request(app, "POST", "/api/training", **multipart([
                    ("更新迴歸版.xlsx", workbook_bytes(rows)),
                ]))
                self.assertEqual(status, 202)
                await app.state.task
            _, report = await request(app, "GET", "/api/reports/latest")
            self.assertEqual((report["task_type"], report["run_id"]), ("regression", new_job["run_id"]))
            self.assertTrue(bundle.joinpath("report.json").is_file())
        write_json(status_path, {
            "run_id": run_id, "status": "running", "phase": "cross_validation", "message": "舊分類任務訊息",
        })
        restarted = create_app(self.root)
        async with restarted.router.lifespan_context(restarted):
            _, job = await request(restarted, "GET", "/api/training/status")
            self.assertEqual((job["status"], job["message"]), ("idle", ""))
            self.assertEqual(job["latest_success_run_id"], new_job["run_id"])
            self.assertEqual(await request(restarted, "GET", "/api/reports/latest"), (200, report))

    async def test_invalid_regression_metadata_precedes_joblib_loading(self):
        artifacts = self.root / "artifacts"
        run_id = str(uuid4())
        bundle = artifacts / run_id
        bundle.mkdir(parents=True)
        write_json(artifacts / "latest_success.json", {"run_id": run_id})
        write_json(bundle / "report.json", {"run_id": run_id, "task_type": "regression", "report_version": 99})
        app = create_app(self.root)
        with patch("backend.storage.joblib.load") as load, self.assertLogs("backend.app", level="ERROR") as logs:
            async with app.router.lifespan_context(app):
                self.assertEqual((await request(app, "GET", "/api/reports/latest"))[0], 404)
                _, status = await request(app, "GET", "/api/training/status")
                self.assertEqual(status["status"], "idle")
            load.assert_not_called()
        self.assertIn("不支援的迴歸報表版本", logs.output[0])


    async def test_uploaded_filenames_survive_restart(self):
        """既有批次、新上傳和重啟後都能回傳已保存的原檔名。"""
        with tempfile.TemporaryDirectory(dir=RUNTIME) as directory:
            root = Path(directory)
            run_id = str(uuid4())
            status_file = root / "artifacts" / "training_status.json"
            status_file.parent.mkdir()
            save_uploads(root, run_id, [("舊資料.xlsx", io.BytesIO(b"old data"))])
            write_json(status_file, {
                "run_id": run_id, "task_type": "regression", "status": "completed", "phase": "completed", "message": "訓練完成",
            })

            endpoint = "/api/training/status"
            app = create_app(root)
            async with app.router.lifespan_context(app):
                status, job = await request(app, "GET", endpoint)
                self.assertEqual((status, job["uploaded_files"]), (200, ["舊資料.xlsx"]))

                new_files = [("新資料.xlsx", b"invalid Excel"), ("新資料.xlsx", b"another file")]
                status, job = await request(app, "POST", "/api/training", **multipart(new_files))
                expected = [filename for filename, _ in new_files]
                self.assertEqual((status, job["uploaded_files"]), (202, expected))
                await app.state.task
                _, job = await request(app, "GET", endpoint)
                self.assertEqual((job["status"], job["uploaded_files"]), ("failed", expected))

                status, _ = await request(app, "POST", "/api/training", **multipart([]))
                self.assertEqual(status, 400)

            restarted = create_app(root)
            async with restarted.router.lifespan_context(restarted):
                _, job = await request(restarted, "GET", endpoint)
                self.assertEqual(job["uploaded_files"], expected)

    async def test_upload_train_restart_and_preserve_previous_success(self):
        """驗證多檔訓練、重啟載入與失敗時保留正式成果。"""
        rows = [EXCEL_HEADERS] + [
            ("重複", n, 2, 3, 4, "(1,1)", "(2,2)", "飛出台面", "(1,1)", None)
            for n in range(1, 16)
        ]
        files = [("任意檔名.xlsx", workbook_bytes(rows))] * 4
        input_values = b'{"angle":13.0,"position":2,"spin":3,"strength":4}'
        with tempfile.TemporaryDirectory(dir=RUNTIME) as directory:
            root = Path(directory)
            app = create_app(root)
            async with app.router.lifespan_context(app):
                self.assertEqual(
                    await request(app, "POST", "/api/predict"),
                    (409, {"error": "請先完成訓練"}),
                )
                self.assertEqual(
                    (await request(app, "POST", "/api/training", **multipart([])))[0], 400,
                )
                with patch("backend.training.TREE_COUNT", 4):
                    status, single_task = await request(
                        app, "POST", "/api/training", **multipart(files[:1]),
                    )
                    self.assertEqual(status, 202)
                    await app.state.task
                    status, single_report = await request(app, "GET", "/api/reports/latest")
                    self.assertEqual(
                        (status, single_report["run_id"]), (200, single_task["run_id"]),
                    )
                    self.assertEqual(single_report["data"]["training_balls"], 45)
                    self.assertEqual(single_report["data"]["training_groups"], 15)
                    self.assertEqual(len(single_report["data"]["sources"]), 1)

                    status, task = await request(app, "POST", "/api/training", **multipart(files))
                    self.assertEqual(status, 202)
                    self.assertEqual(
                        await request(app, "POST", "/api/training", **multipart(files)),
                        (409, {"error": "已有訓練進行中"}),
                    )
                    await app.state.task
                run_id = task["run_id"]
                status, task = await request(app, "GET", "/api/training/status")
                self.assertEqual((status, task["status"]), (200, "completed"))
                status, report = await request(app, "GET", "/api/reports/latest")
                self.assertEqual((status, report["run_id"]), (200, run_id))
                self.assertEqual(report["data"]["training_balls"], 180)
                self.assertEqual(report["data"]["training_groups"], 15)
                keys = ("total_balls", "valid_balls", "invalid_balls", "missing_balls")
                self.assertEqual([report["data"][key] for key in keys], [300, 180, 60, 60])
                self.assertEqual((report["task_type"], report["report_version"]), ("regression", 1))
                self.assertEqual(report["evaluation"]["balls"], 180)
                matrix = report["data_summary"]["pearson"]["matrix"]
                for index in (1, 2, 3):
                    self.assertTrue(all(value is None for value in matrix[index]))
                    self.assertTrue(all(row[index] is None for row in matrix))
                self.assertEqual([matrix[i][i] for i in (0, 4, 5)], [1.0, 1.0, 1.0])
                self.assertEqual(len(report["data"]["sources"]), 4)
                with (root / "artifacts" / run_id / "fold_predictions.csv").open(
                    encoding="utf-8-sig", newline=""
                ) as stream:
                    records = list(csv.DictReader(stream))
                self.assertEqual(len(records), 180)
                self.assertEqual(len({row["ball_id"] for row in records}), 180)
                self.assertTrue(any(float(row["predicted_x"]) % 1 for row in records))
                folds_by_settings = {}
                for row in records:
                    settings = tuple(row[key] for key in ("angle", "position", "spin", "strength"))
                    folds_by_settings.setdefault(settings, set()).add(row["fold"])
                self.assertTrue(all(len(folds) == 1 for folds in folds_by_settings.values()))
                self.assertEqual({row["fold"] for row in records}, set("ABCDE"))
                for row in records:
                    self.assertEqual(row["predicted_x"], row[report["winners"]["x"]])
                    self.assertEqual(row["predicted_y"], row[report["winners"]["y"]])
                    dx = float(row["predicted_x"]) - int(row["actual_x"])
                    dy = float(row["predicted_y"]) - int(row["actual_y"])
                    self.assertAlmostEqual(float(row["dx"]), dx)
                    self.assertAlmostEqual(float(row["dy"]), dy)
                    self.assertAlmostEqual(float(row["distance"]), (dx ** 2 + dy ** 2) ** 0.5)
                for fold in "ABCDE":
                    training = [row for row in records if row["fold"] != fold]
                    validation = [row for row in records if row["fold"] == fold]
                    for axis in "xy":
                        baseline = sum(int(row[f"actual_{axis}"]) for row in training) / len(training)
                        self.assertTrue(all(float(row[f"baseline_{axis}"]) == baseline for row in validation))
                self.assertEqual(
                    (await request(app, "POST", "/api/predict", body=input_values))[1]["run_id"],
                    run_id,
                )
                status, error = await request(
                    app, "POST", "/api/predict",
                    body=input_values.replace(b"13.0", b"13.000000000000001"),
                )
                self.assertEqual((status, error["field"]), (422, "仰角角度"))
                broken = [*files[:2], ("壞檔.xlsx", b"bad data")]
                self.assertEqual(
                    (await request(app, "POST", "/api/training", **multipart(broken)))[0], 202,
                )
                await app.state.task
                status, failed = await request(app, "GET", "/api/training/status")
                self.assertEqual(
                    (status, failed["status"], failed["file"]), (200, "failed", "壞檔.xlsx"),
                )
                self.assertEqual(failed["latest_success_run_id"], run_id)

                def reject_publication(path, payload):
                    if path.name == "latest_success.json":
                        raise OSError("simulated publication failure")
                    write_json(path, payload)

                with (
                    patch("backend.training.TREE_COUNT", 4),
                    patch("backend.storage.write_json", side_effect=reject_publication),
                    self.assertLogs("backend.app", level="ERROR"),
                ):
                    self.assertEqual(
                        (await request(app, "POST", "/api/training", **multipart(files)))[0],
                        202,
                    )
                    await app.state.task
                _, failed = await request(app, "GET", "/api/training/status")
                self.assertEqual((failed["status"], failed["phase"]), ("failed", "publishing"))
                self.assertEqual(failed["latest_success_run_id"], run_id)
                self.assertEqual(
                    (await request(app, "POST", "/api/predict", body=input_values))[1]["run_id"],
                    run_id,
                )

            self.assertEqual(
                read_json(root / "artifacts" / "latest_success.json"), {"run_id": run_id},
            )
            restarted = create_app(root)
            async with restarted.router.lifespan_context(restarted):
                self.assertEqual(
                    await request(restarted, "GET", "/api/reports/latest"), (200, report),
                )
                status, result = await request(restarted, "POST", "/api/predict", body=input_values)
                self.assertEqual(
                    (status, result["run_id"], result["comparison"]), (200, run_id, None),
                )

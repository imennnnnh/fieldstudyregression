import csv
import json
import logging
import shutil
from dataclasses import asdict, dataclass, replace
from hashlib import file_digest
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from uuid import UUID

import joblib
import sklearn
from sklearn.base import is_regressor
from sklearn.utils.validation import check_is_fitted

from .excel_loader import PARAMETER_KEYS, ExcelSource
from .training import validation_hits


TASK_TYPE = "regression"
REPORT_VERSION = 1
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class PublishedRun:
    report: dict
    models: dict

    @property
    def run_id(self):
        return self.report["run_id"]


@dataclass(frozen=True)
class TrainingFile:
    filename: str
    upload_run_id: str
    file_id: int
    sha256: str | None = None

    def __post_init__(self):
        if (str(UUID(self.upload_run_id)) != self.upload_run_id or
                type(self.file_id) is not int or self.file_id < 1 or
                not isinstance(self.filename, str) or not self.filename):
            raise ValueError("已保存的訓練檔案資料不完整。")

    def path(self, data_dir):
        return data_dir / "uploads" / self.upload_run_id / f"{self.file_id}.xlsx"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, payload):
    # 暫存檔與目標放在同一磁碟區，以一次取代發布完整 JSON。
    with NamedTemporaryFile(dir=path.parent, delete=False, mode="w", encoding="utf-8") as stream:
        temporary = Path(stream.name)
        try:
            json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def save_uploads(data_dir, run_id, files):
    directory = data_dir / "uploads" / run_id
    directory.mkdir(parents=True)
    sources = []
    for number, (filename, stream) in enumerate(files, start=1):
        path = directory / f"{number}.xlsx"
        with path.open("wb") as destination:
            shutil.copyfileobj(stream, destination)
        sources.append(ExcelSource(number, filename, path))
    write_json(directory / "sources.json", [
        {"file_id": source.file_id, "filename": source.filename, "stored_as": source.path.name}
        for source in sources
    ])
    return sources


def load_upload_manifest(data_dir, run_id):
    try:
        directory = data_dir / "uploads" / str(UUID(str(run_id)))
        manifest = read_json(directory / "sources.json")
    except (OSError, ValueError):
        return []
    if not isinstance(manifest, list):
        return []
    return [
        source for source in manifest
        if isinstance(source, dict) and isinstance(source.get("filename"), str)
    ]


def load_uploaded_filenames(data_dir, run_id):
    """讀取既有訓練批次的上傳原檔名。"""
    return [source["filename"] for source in load_upload_manifest(data_dir, run_id)]


def with_training_files(pointer, files):
    return {**pointer, "training_files": [asdict(file) for file in files]}


def load_training_files(data_dir, artifacts, published):
    """只從正式模型的成功批次移轉舊檔。持久保存的空清單同樣有效。"""
    pointer_path = artifacts / "latest_success.json"
    if not pointer_path.is_file():
        return []
    pointer = read_json(pointer_path)
    if "training_files" in pointer:
        return [TrainingFile(**file) for file in pointer["training_files"]]
    if published is None:
        return []

    files = []
    seen = set()
    sources = published.report["data"].get("sources") or load_upload_manifest(data_dir, published.run_id)
    for source in sources:
        file = TrainingFile(source["filename"], published.run_id, source["file_id"])
        path = file.path(data_dir)
        if not path.is_file():
            files.append(file)
            continue
        try:
            with path.open("rb") as stream:
                digest = file_digest(stream, "sha256").hexdigest()
        except FileNotFoundError:
            files.append(file)
            continue
        if digest not in seen:
            seen.add(digest)
            files.append(replace(file, sha256=digest))
    write_json(pointer_path, with_training_files(pointer, files))
    return files


def clear_training_files(artifacts):
    pointer_path = artifacts / "latest_success.json"
    pointer = read_json(pointer_path) if pointer_path.is_file() else {"run_id": None}
    write_json(pointer_path, with_training_files(pointer, []))


def stage_training_files(data_dir, run_id, saved_files, uploads):
    """按內容去重，僅保存新增的 Excel，並重新編排本批次的來源編號。"""
    files = []
    seen = set()
    for file in saved_files:
        path = file.path(data_dir)
        if not path.is_file():
            continue
        digest = file.sha256
        if digest is None:
            with path.open("rb") as stream:
                digest = file_digest(stream, "sha256").hexdigest()
        if digest not in seen:
            seen.add(digest)
            files.append(replace(file, sha256=digest))

    new_uploads = []
    digests = []
    for filename, stream in uploads:
        stream.seek(0)
        digest = file_digest(stream, "sha256").hexdigest()
        if digest not in seen:
            seen.add(digest)
            stream.seek(0)
            new_uploads.append((filename, stream))
            digests.append(digest)
    if not new_uploads:
        return [], [], []

    new_files = [
        TrainingFile(source.filename, run_id, source.file_id, digest)
        for source, digest in zip(save_uploads(data_dir, run_id, new_uploads), digests, strict=True)
    ]
    files.extend(new_files)
    sources = [
        ExcelSource(index, file.filename, file.path(data_dir))
        for index, file in enumerate(files, start=1)
    ]
    return files, sources, [file.filename for file in new_files]


def load_bundle(directory, run_id, *, skip_legacy=False):
    report = read_json(directory / "report.json")
    if not isinstance(report, dict):
        raise ValueError("訓練報表須為 JSON 物件。")
    if report.get("task_type") != TASK_TYPE:
        if skip_legacy:
            LOGGER.info("Skipping legacy training report for run %s", run_id)
            return None
        raise ValueError("訓練報表的任務類型不符。")
    if type(report.get("report_version")) is not int or report["report_version"] != REPORT_VERSION:
        raise ValueError(f"不支援的迴歸報表版本（{report.get('report_version')}）。")
    if report["run_id"] != run_id or report["scikit_learn_version"] != sklearn.__version__:
        raise ValueError("訓練批次或 scikit-learn 版本不符。")
    with (directory / "fold_predictions.csv").open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if "ball_id" not in (reader.fieldnames or []):
            raise ValueError("逐折驗證紀錄不完整。")
        if "validation_hits" not in report:
            rows = list(reader)
            report["validation_hits"] = validation_hits(rows)
            ball_ids = [row["ball_id"] for row in rows]
        else:
            ball_ids = [row["ball_id"] for row in reader]
        if len(ball_ids) != report["data"]["training_balls"] or len(set(ball_ids)) != len(ball_ids) or not all(ball_ids):
            raise ValueError("逐折驗證紀錄的球數或唯一球號不符。")
    models = {axis: joblib.load(directory / f"model_{axis}.joblib") for axis in "xy"}
    for axis, model in models.items():
        if not is_regressor(model):
            raise ValueError(f"{axis.upper()} 軸模型須為迴歸模型。")
        check_is_fitted(model, attributes=["n_features_in_", "estimators_"])
        if model.n_features_in_ != len(PARAMETER_KEYS):
            raise ValueError(f"{axis.upper()} 軸模型的輸入參數數目不符。")
    return PublishedRun(report, models)


def publish(artifacts, run_id, models, records, report, training_files):
    with TemporaryDirectory(dir=artifacts, prefix=".staging-") as name:
        staging = Path(name)
        bundle = staging / run_id
        bundle.mkdir()
        for axis, model in models.items():
            joblib.dump(model, bundle / f"model_{axis}.joblib", compress=3)
        with (bundle / "fold_predictions.csv").open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=records[0].keys())
            writer.writeheader()
            writer.writerows(records)
        write_json(bundle / "report.json", {
            **report,
            "task_type": TASK_TYPE,
            "report_version": REPORT_VERSION,
            "scikit_learn_version": sklearn.__version__,
        })
        published = load_bundle(bundle, run_id)
        bundle.rename(artifacts / run_id)
    # 同一次原子替換提交模型和訓練清單，重啟時兩者會來自同一批次。
    write_json(artifacts / "latest_success.json", with_training_files({"run_id": run_id}, training_files))
    return published


def load_latest(artifacts):
    pointer = artifacts / "latest_success.json"
    if not pointer.is_file():
        return None
    run_id = read_json(pointer)["run_id"]
    if run_id is None:
        return None
    run_id = str(UUID(run_id))
    return load_bundle(artifacts / run_id, run_id, skip_legacy=True)

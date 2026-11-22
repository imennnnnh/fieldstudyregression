"use strict";

const byId = (id) => document.getElementById(id);
const siteHeader = document.querySelector(".site-header");
const menuToggle = byId("menu-toggle");
const navigation = byId("site-navigation");
const views = [
  { id: "training-view", link: byId("training-link"), heading: byId("training-heading") },
  { id: "prediction-view", link: byId("prediction-link"), heading: byId("prediction-heading") },
];
const files = byId("files");
const testFile = byId("test-file");
const measuredStatus = byId("measured-status");
const measuredCoordinates = byId("measured-coordinates");
const measuredX = measuredCoordinates.querySelector('[name="x"]');
const measuredY = measuredCoordinates.querySelector('[name="y"]');
const predictionForm = byId("prediction-form");
const predictionResult = byId("prediction-result");
const predictionHeatmap = byId("prediction-heatmap-grid");
const predictionMarker = byId("prediction-heatmap-marker");
const heatmapCells = [];
const number = new Intl.NumberFormat("zh-TW");
const cells = [1, 2, 3, 4, 5];
const phases = {
  uploading: "上傳資料",
  reading: "讀取、驗證與展開",
  analyzing: "篩選有效球",
  splitting: "五折切分",
  cross_validation: "五折訓練與驗證",
  evaluating: "選模與整批評估",
  refitting: "正式模型重訓",
  publishing: "保存與發布",
};
let trainingActive = false;
let lastJobStatus = null;
let submitting = false;
let predicting = false;
let lastPrediction = null;
let predictionRevision = 0;
let testing = false;
let displayedRun = null;
let latestRun = null;
let testedRun = null;
let polling = null;

const formatLanding = (x, y) => "(" + x + ", " + y + ")";
const activeJob = (job) => job.status === "uploading" || job.status === "running";

function setMenuOpen(open) {
  menuToggle.setAttribute("aria-expanded", String(open));
  siteHeader.classList.toggle("menu-open", open);
}

function showView(view, moveFocus = false) {
  for (const item of views) {
    byId(item.id).hidden = item !== view;
    if (item === view) item.link.setAttribute("aria-current", "page");
    else item.link.removeAttribute("aria-current");
  }
  setMenuOpen(false);
  if (moveFocus) {
    window.scrollTo(0, 0);
    view.heading.focus({ preventScroll: true });
  }
}

function viewFromLocation() {
  return views.find((view) => window.location.hash === "#" + view.id) ?? views[0];
}

function navigate(event, view) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const hash = "#" + view.id;
  if (window.location.hash !== hash) window.history.pushState(null, "", hash);
  showView(view, true);
}

for (const view of views) {
  view.link.addEventListener("click", (event) => navigate(event, view));
}
byId("home-link").addEventListener("click", (event) => navigate(event, views[0]));
window.addEventListener("hashchange", () => showView(viewFromLocation(), true));

menuToggle.addEventListener("click", () => {
  setMenuOpen(menuToggle.getAttribute("aria-expanded") !== "true");
});
document.addEventListener("click", (event) => {
  if (!navigation.contains(event.target) && !menuToggle.contains(event.target)) setMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuToggle.getAttribute("aria-expanded") === "true") {
    setMenuOpen(false);
    menuToggle.focus();
  }
});
window.matchMedia("(min-width: 60rem)").addEventListener("change", () => setMenuOpen(false));
showView(viewFromLocation());

async function api(path, options) {
  const response = await fetch(path, options);
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;
  if (!response.ok || !payload) {
    const error = new Error(payload?.error ?? ("請求失敗（HTTP " + response.status + "）"));
    error.status = response.status;
    error.counts = payload?.counts;
    throw error;
  }
  return payload;
}

function excelSelectionError(input, single = false) {
  if (!input.files.length) {
    return single ? "請選擇一份測試用 .xlsx 檔案。" : "請至少選擇一份訓練用 .xlsx 檔案。";
  }
  if (single && input.files.length !== 1) {
    return "每次只能上傳一份測試用 .xlsx 檔案。";
  }
  const invalidFile = Array.from(input.files).find((file) => !/\.xlsx$/i.test(file.name));
  return invalidFile ? "「" + invalidFile.name + "」須為 .xlsx 檔案。" : "";
}

function showModelState(state, message) {
  const indicator = byId("model-state");
  indicator.dataset.state = state;
  const text = byId("model-state-text");
  if (text.textContent !== message) text.textContent = message;
}

function updateButtons() {
  files.disabled = trainingActive || submitting;
  byId("train-button").disabled = files.disabled || Boolean(excelSelectionError(files));
  byId("predict-button").disabled = predicting || !displayedRun;

  const modelReady = Boolean(latestRun) && latestRun === displayedRun;
  const testHint = byId("test-model-hint");
  if (modelReady) {
    showModelState("ready", "已就緒");
    testHint.textContent = "";
  } else if (latestRun) {
    showModelState("checking", "載入中…");
    testHint.textContent = "正在載入正式模型報表…";
  } else if (lastJobStatus === "completed") {
    showModelState("unavailable", "尚未就緒");
    testHint.textContent = "訓練已完成，但目前無法載入正式模型。請查看後端終端機訊息。";
  } else {
    if (trainingActive || submitting) showModelState("training", "訓練中");
    else if (lastJobStatus === null) showModelState("checking", "確認中…");
    else showModelState("unavailable", lastJobStatus === "idle" ? "等待訓練" : "尚未就緒");
    testHint.textContent = lastJobStatus === null ? "正在確認正式模型…" : "等待訓練迴歸模型";
  }

  testFile.disabled = testing;
  byId("evaluate-button").disabled = testing || !modelReady || Boolean(excelSelectionError(testFile, true));
}

function showStatus(id, message, error = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle("error", error);
}

function renderFileList(list, filenames) {
  if (list.children.length === filenames.length &&
      filenames.every((name, index) => list.children[index].textContent === name)) return;
  const items = document.createDocumentFragment();
  for (const name of filenames) {
    const item = document.createElement("li");
    item.textContent = name;
    items.append(item);
  }
  list.replaceChildren(items);
}

function renderJob(job) {
  lastJobStatus = job.status;
  trainingActive = activeJob(job);
  updateButtons();
  const uploadedFiles = job.uploaded_files ?? [];
  renderFileList(byId("uploaded-files"), uploadedFiles);
  byId("uploaded-training").hidden = !uploadedFiles.length;
  const progress = byId("train-progress");
  progress.hidden = !trainingActive || !job.total;
  if (!progress.hidden) {
    progress.max = job.total;
    progress.value = job.completed;
  }
  const stage = phases[job.phase];
  let message = job.message;
  if (stage) message = stage + " · " + message;
  if (!progress.hidden) message += "（" + job.completed + " / " + job.total + "）";
  if (job.status === "failed") message = "訓練失敗｜" + message;
  showStatus("train-status", message, job.status === "failed");
  byId("data-counts").textContent = job.counts ? formatCounts(job.counts) : "";
}

function formatCounts(counts) {
  const outcomes = "有效 " + number.format(counts.valid_balls) +
    " 球、無效 " + number.format(counts.invalid_balls) +
    " 球、缺測 " + number.format(counts.missing_balls) + " 球";
  const total = counts.total_balls === undefined ? "" : "共 " + number.format(counts.total_balls) + " 球位，";
  const training = counts.training_balls === undefined ? "" :
    "。納入迴歸 " + number.format(counts.training_balls) + " 球，涵蓋 " +
    number.format(counts.training_groups) + " 組四參數";
  return total + outcomes + training;
}

function renderTable(id, caption, columns, rows, renderCell = (cell, value) => { cell.textContent = value; }) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrap";
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("aria-label", caption);
  const table = document.createElement("table");
  table.createCaption().textContent = caption;
  function heading(row, label, scope) {
    const cell = document.createElement("th");
    cell.textContent = label;
    cell.scope = scope;
    row.append(cell);
  }
  const header = table.createTHead().insertRow();
  for (const label of columns) heading(header, label, "col");
  const body = table.createTBody();
  for (const [label, ...values] of rows) {
    const row = body.insertRow();
    heading(row, label, "row");
    for (const value of values) renderCell(row.insertCell(), value);
  }
  wrapper.append(table);
  byId(id).replaceChildren(wrapper);
}

function renderDistribution(summary) {
  renderTable("axis-distribution", "各軸每格有效球數", ["軸", ...cells], [
    ["X 軸", ...summary.x_counts.map(number.format)],
    ["Y 軸", ...summary.y_counts.map(number.format)],
  ]);
  renderTable("landing-grid", "5×5 落點表（有效球數／四參數組數）",
    ["Y ＼ X", ...cells],
    summary.grid.map((row, i) => [i + 1, ...row.map(({ balls, groups }) =>
      number.format(balls) + "／" + number.format(groups))]),
  );
  byId("unobserved-cells").textContent = summary.unobserved_cells.length
    ? "未觀測格 " + summary.unobserved_cells.map(([x, y]) => formatLanding(x, y)).join("、")
    : "25 格皆有觀測";
  byId("observed-minimum").textContent =
    "有觀測的格子中，最少為 " + number.format(summary.min_observed_balls) + " 球。";
  byId("coverage-warning").textContent = summary.sparse_cells.length
    ? "以下格子涵蓋少於五組四參數，無法覆蓋全部五折。 " + summary.sparse_cells
      .map(({ x, y, balls, groups }) => formatLanding(x, y) + " " +
        number.format(balls) + " 球／" + number.format(groups) + " 組").join("、")
    : "";

  const { labels, matrix } = summary.pearson;
  renderTable("pearson", "Pearson 相關係數", ["欄位", ...labels],
    matrix.map((row, index) => [labels[index], ...row]), (cell, value) => {
      cell.className = value === null ? "correlation correlation-missing" : "correlation";
      cell.textContent = value === null ? "無法計算" : value.toFixed(3);
      if (value !== null) {
        cell.style.setProperty("--correlation-color", value < 0 ? "#2e6bbd" : "#be535d");
        cell.style.setProperty("--correlation-weight", (Math.abs(value) * 100) + "%");
      }
    },
  );
}

function renderEvaluation(id, caption, batches) {
  const rows = [
    ["X 軸 MAE（格）", "x", "mae"],
    ["X 軸 MSE（格²）", "x", "mse"],
    ["X 軸 RMSE（格）", "x", "rmse"],
    ["Y 軸 MAE（格）", "y", "mae"],
    ["Y 軸 MSE（格²）", "y", "mse"],
    ["Y 軸 RMSE（格）", "y", "rmse"],
    ["雙軸平均歐氏距離（格）", "mean_distance"],
    ["雙軸 RMSE（格）", "rmse_distance"],
  ];
  renderTable(id, caption, ["指標", ...batches.map(([name]) => name)], rows.map(([label, key, metric]) => [
    label, ...batches.map(([, values]) => (metric ? values[key][metric] : values[key]).toFixed(4)),
  ]));
}

function renderReport(report) {
  if (!displayedRun) showStatus("prediction-status", "等待輸入參數");
  displayedRun = report.run_id;
  updateButtons();
  byId("report-status").hidden = true;
  byId("report-note").textContent = report.note;
  byId("report-counts").textContent = formatCounts(report.data);
  renderDistribution(report.data_summary);

  const split = report.split;
  byId("split-method").textContent = "切分方法 " + split.method +
    (split.fallback_reason ? "。改用 GroupKFold 的原因為" + split.fallback_reason : "");
  byId("split-warning").textContent = split.warnings.length ? "分層切分警告／" + split.warnings.join("／") : "";
  renderTable("fold-summary", "各折資料量", ["折別", "訓練球數", "訓練組數", "驗證球數", "驗證組數"],
    Object.entries(split.folds).map(([fold, counts]) => [fold, ...[
      counts.training_balls, counts.training_groups, counts.validation_balls, counts.validation_groups,
    ].map(number.format)]),
  );

  byId("selected-models").textContent =
    "勝出模型　X 軸 " + report.winners.x + "　Y 軸 " + report.winners.y + "　訓練批次 " + report.run_id;
  const names = { baseline_x: "X 軸基準線（僅供比較）", baseline_y: "Y 軸基準線（僅供比較）" };
  renderTable("scores", "五折平均 MSE（格²，每折同權）", ["模型", ..."ABCDE", "五折平均"],
    Object.entries(report.selection).map(([name, candidate]) => [
      names[name] ?? name, ...Array.from("ABCDE", (fold) => candidate.folds[fold].toFixed(4)),
      candidate.mean.toFixed(4),
    ]),
  );
  byId("validation-count").textContent =
    "驗證球數 " + number.format(report.evaluation.balls) + "。全部留出球的 MSE 及其他誤差皆為每球同權。";
  renderEvaluation("metrics", "迴歸模型與基準線", [
    ["兩軸勝出模型", report.evaluation], ["基準線", report.baseline_evaluation],
  ]);
  byId("report").hidden = false;
}

function clearTestResult() {
  testedRun = null;
  byId("test-result").hidden = true;
}

function renderTestReport(result) {
  byId("test-source").textContent =
    "測試檔案 " + result.filename + "　正式模型批次 " + result.run_id;
  byId("test-count").textContent = formatCounts(result.counts) + "。以有效球計算誤差，每球同權。";
  renderEvaluation("test-metrics", "獨立測試誤差", [["正式模型", result.evaluation]]);
  testedRun = result.run_id;
  byId("test-result").hidden = false;
}

function observePublishedRun(runId) {
  latestRun = runId;
  if (testedRun && testedRun !== latestRun) {
    clearTestResult();
    showStatus("test-status", "正式模型已更新，請重新執行獨立測試。");
  }
}

async function refreshJob() {
  if (polling !== null) return polling;
  polling = (async () => {
    try {
      const job = await api("/api/training/status");
      observePublishedRun(job.latest_success_run_id);
      renderJob(job);
      if (latestRun && latestRun !== displayedRun) {
        const report = await api("/api/reports/latest");
        observePublishedRun(report.run_id);
        renderReport(report);
      }
    } catch (error) {
      if (!displayedRun || latestRun !== displayedRun) showModelState("unavailable", "暫時無法確認");
      showStatus("train-status", "無法更新訓練狀態，將重新連線。 " + error.message, true);
    } finally {
      polling = null;
    }
  })();
  return polling;
}

files.addEventListener("change", () => {
  renderFileList(byId("selected-files"), Array.from(files.files, (file) => file.name));
  byId("selected-training").hidden = !files.files.length;
  const error = excelSelectionError(files);
  files.setCustomValidity(error);
  byId("train-file-error").textContent = files.files.length ? error : "";
  updateButtons();
});

byId("training-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting || trainingActive || excelSelectionError(files)) return;
  const body = new FormData(event.currentTarget);
  submitting = true;
  updateButtons();
  showStatus("train-status", "正在上傳 Excel…");
  try {
    renderJob(await api("/api/training", { method: "POST", body }));
  } catch (error) {
    showStatus("train-status", error.message, true);
  } finally {
    submitting = false;
    updateButtons();
  }
  await refreshJob();
});

testFile.addEventListener("change", () => {
  clearTestResult();
  byId("test-filename").textContent = testFile.files[0]?.name ?? "";
  const error = testFile.files.length ? excelSelectionError(testFile, true) : "";
  showStatus("test-status", error, Boolean(error));
  updateButtons();
});

byId("test-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (testing || excelSelectionError(testFile, true)) return;
  if (!latestRun) {
    showStatus("test-status", "請先完成訓練", true);
    return;
  }
  if (latestRun !== displayedRun) {
    showStatus("test-status", "正在載入最新正式模型的報表，載入後請重新評估。", true);
    return;
  }

  const requestedRun = latestRun;
  const body = new FormData(event.currentTarget);
  clearTestResult();
  testing = true;
  updateButtons();
  showStatus("test-status", "正在讀取測試 Excel 並評估…");
  try {
    const result = await api("/api/evaluation", { method: "POST", body });
    await refreshJob();
    if (result.run_id !== requestedRun || result.run_id !== latestRun || result.run_id !== displayedRun) {
      throw new Error("正式模型已更新，請重新執行獨立測試。");
    }
    renderTestReport(result);
    showStatus("test-status", "評估完成");
  } catch (error) {
    clearTestResult();
    const counts = error.status === 422 && error.counts ? "（" + formatCounts(error.counts) + "）" : "";
    showStatus("test-status", "評估失敗｜" + error.message + counts, true);
  } finally {
    testing = false;
    updateButtons();
  }
});

function comparisonMessage() {
  if (!lastPrediction) return "完成單球預測後即可比對。";
  if (measuredStatus.value === "unfilled") return "選擇實測結果即可比對。";

  if (measuredStatus.value === "invalid") return "實測為無效球，無座標可比對";
  if (!measuredX.validity.valid || !measuredY.validity.valid) {
    return "請輸入 1–5 的整數座標。";
  }
  const x = measuredX.valueAsNumber;
  const y = measuredY.valueAsNumber;
  const dx = lastPrediction.x - x;
  const dy = lastPrediction.y - y;
  return "實測 " + formatLanding(x, y) + " · X 軸絕對誤差 " + Math.abs(dx).toFixed(3) +
    " 格、Y 軸絕對誤差 " + Math.abs(dy).toFixed(3) +
    " 格、雙軸距離 " + Math.hypot(dx, dy).toFixed(3) + " 格";
}

function renderComparison() {
  const comparison = byId("comparison");
  const message = comparisonMessage();
  if (comparison.textContent !== message) comparison.textContent = message;
}

function updateMeasuredFields() {
  const enabled = measuredStatus.value === "valid";
  measuredCoordinates.hidden = !enabled;
  measuredCoordinates.disabled = !enabled;
  renderComparison();
}

measuredStatus.addEventListener("change", updateMeasuredFields);
measuredCoordinates.addEventListener("input", renderComparison);

function buildPredictionHeatmap() {
  // In Player A's view, X increases down the rows and Y increases across the columns.
  for (let x = 0; x <= 6; x++) {
    for (let y = 0; y <= 6; y++) {
      const cell = document.createElement("div");
      cell.className = "prediction-heatmap-cell";
      if (x > 0 && x < 6 && y > 0 && y < 6) {
        cell.classList.add("prediction-heatmap-valid");
        const label = document.createElement("span");
        label.textContent = "(" + x + "," + y + ")";
        cell.append(label);
        heatmapCells.push({ x, y, cell });
      }
      predictionHeatmap.append(cell);
    }
  }
}

function renderPredictionHeatmap(prediction) {
  for (const { x, y, cell } of heatmapCells) {
    if (prediction) {
      const distance = Math.hypot(x - prediction.x, y - prediction.y);
      cell.style.setProperty("--heatmap-strength", Math.max(0, 1 - distance / 2));
    } else {
      cell.style.removeProperty("--heatmap-strength");
    }
  }
  predictionMarker.hidden = !prediction;
  if (prediction) {
    predictionMarker.style.left = (prediction.y - 0.5) / 5 * 100 + "%";
    predictionMarker.style.top = (prediction.x - 0.5) / 5 * 100 + "%";
  }
}

function clearPrediction() {
  lastPrediction = null;
  renderPredictionHeatmap(null);
  renderComparison();
}

predictionForm.addEventListener("input", () => {
  predictionRevision++;
  if (!predictionResult.dataset.state) return;
  delete predictionResult.dataset.state;
  clearPrediction();
  showStatus("prediction-status", "請按「預測落點」更新結果。");
});

predictionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!displayedRun || predicting) return;
  const payload = Object.fromEntries(new FormData(predictionForm));
  const revision = predictionRevision;
  predicting = true;
  clearPrediction();
  updateButtons();
  predictionResult.dataset.state = "pending";
  showStatus("prediction-status", "正在預測…");
  try {
    const result = await api("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (revision !== predictionRevision) return;
    lastPrediction = result;
    predictionResult.dataset.state = "ready";
    showStatus("prediction-status", formatLanding(result.x.toFixed(2), result.y.toFixed(2)));
    renderPredictionHeatmap(result);
    renderComparison();
  } catch (error) {
    if (revision !== predictionRevision) return;
    predictionResult.dataset.state = "error";
    showStatus("prediction-status", error.message, true);
  } finally {
    predicting = false;
    updateButtons();
  }
});

function updateHeaderScroll() {
  siteHeader.classList.toggle("is-scrolled", window.scrollY > 8);
}

window.addEventListener("scroll", updateHeaderScroll, { passive: true });
updateHeaderScroll();
buildPredictionHeatmap();
updateMeasuredFields();
updateButtons();
refreshJob();
setInterval(refreshJob, 1500);

new IntersectionObserver(([entry]) => {
  document.body.classList.toggle("can-scroll-down", !entry.isIntersecting);
}).observe(byId("page-end"));

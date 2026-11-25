"use strict";

const byId = (id) => document.getElementById(id);
const siteHeader = document.querySelector(".site-header");
const brand = byId("home-link");
const navigation = byId("site-navigation");
const bottomNavigation = byId("bottom-navigation");
const wideLayout = window.matchMedia("(min-width: 46rem)");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const motionStyles = getComputedStyle(document.documentElement);
const motion = {
  settle: parseFloat(motionStyles.getPropertyValue("--motion-settle")),
  page: parseFloat(motionStyles.getPropertyValue("--motion-page")),
  easing: motionStyles.getPropertyValue("--motion-ease").trim(),
};
const revealAnimations = new Map();
let activeView = null;
const views = [
  {
    id: "training-view", link: byId("training-link"), mobileLink: byId("mobile-training-link"),
    heading: byId("training-heading"),
    panels: [byId("training"), byId("independent-test")],
  },
  {
    id: "prediction-view", link: byId("prediction-link"), mobileLink: byId("mobile-prediction-link"),
    heading: byId("prediction-heading"),
    panels: [byId("prediction"), byId("prediction-heatmap")],
  },
];
const files = byId("files");
const clearTraining = byId("clear-training-files");
const testFile = byId("test-file");
const clearTestFile = byId("clear-test-file");
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
const foldLabels = [..."ABCDE"];
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
let clearingTraining = false;
let savedTrainingCount = 0;
let submittedRun = null;
let predicting = false;
let lastPrediction = null;
let predictionRevision = 0;
let testing = false;
let displayedRun = null;
let latestRun = null;
let testedRun = null;
let polling = null;
let pollTimer;

const formatLanding = (x, y) => "(" + x + ", " + y + ")";
const activeJob = (job) => job.status === "uploading" || job.status === "running";

function reveal(element, { distance = 4, scale = 1, duration = motion.settle } = {}) {
  if (reduceMotion.matches || document.hidden || element.closest("[hidden]") ||
      typeof element.animate !== "function" || revealAnimations.has(element)) return;
  const start = { opacity: 0.88 };
  const end = { opacity: 1 };
  if (distance) {
    start.translate = `0 ${distance}px`;
    end.translate = "0 0";
  }
  if (scale !== 1) {
    start.scale = scale;
    end.scale = 1;
  }
  const animation = element.animate([start, end], {
    duration, easing: motion.easing,
  });
  revealAnimations.set(element, animation);
  animation.onfinish = () => {
    if (revealAnimations.get(element) === animation) revealAnimations.delete(element);
  };
}

function revealView(view, distance) {
  for (const panel of view.panels) reveal(panel, { distance, duration: motion.page });
}

function showView(view, moveFocus = false) {
  const changed = activeView !== view;
  if (changed && activeView?.id === "prediction-view") {
    byId(activeView.id).style.removeProperty("padding-block-end");
  }
  activeView = view;
  for (const item of views) {
    byId(item.id).hidden = item !== view;
    for (const link of [item.link, item.mobileLink]) {
      if (item === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }
  if (moveFocus) {
    window.scrollTo(0, 0);
    view.heading.focus({ preventScroll: true });
    if (changed) revealView(view, wideLayout.matches ? 4 : 0);
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
  view.mobileLink.addEventListener("click", (event) => navigate(event, view));
}
brand.addEventListener("click", (event) => navigate(event, views[0]));
window.addEventListener("hashchange", () => showView(viewFromLocation(), true));

wideLayout.addEventListener("change", () => {
  const previousNavigation = wideLayout.matches ? bottomNavigation : navigation;
  if (previousNavigation.contains(document.activeElement)) {
    const link = wideLayout.matches ? activeView.link : activeView.mobileLink;
    link.focus({ preventScroll: true });
  }
});
reduceMotion.addEventListener("change", () => {
  if (!reduceMotion.matches) return;
  for (const animation of revealAnimations.values()) animation.cancel();
  revealAnimations.clear();
});
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
  if (indicator.dataset.state !== state) indicator.dataset.state = state;
  setText(byId("model-state-text"), message);
}

function updateButtons() {
  files.disabled = trainingActive || submitting || clearingTraining;
  byId("train-button").disabled = files.disabled || Boolean(excelSelectionError(files));
  clearTraining.disabled = files.disabled || lastJobStatus === null || !(savedTrainingCount || files.files.length);
  byId("predict-button").disabled = predicting || !displayedRun;

  const modelReady = Boolean(latestRun) && latestRun === displayedRun;
  const testHint = byId("test-model-hint");
  if (modelReady) {
    showModelState("ready", "已就緒");
    setText(testHint, "");
  } else if (latestRun) {
    showModelState("checking", "載入中…");
    setText(testHint, "正在載入正式模型報表…");
  } else if (lastJobStatus === "completed") {
    showModelState("unavailable", "尚未就緒");
    setText(testHint, "訓練已完成，但目前無法載入正式模型。請查看後端終端機訊息。");
  } else {
    if (trainingActive || submitting) showModelState("training", "訓練中");
    else if (lastJobStatus === null) showModelState("checking", "確認中…");
    else showModelState("unavailable", lastJobStatus === "idle" ? "等待訓練" : "尚未就緒");
    setText(testHint, lastJobStatus === null ? "正在確認正式模型…" : "等待訓練迴歸模型");
  }

  testFile.disabled = testing;
  byId("evaluate-button").disabled = testing || !modelReady || Boolean(excelSelectionError(testFile, true));
  clearTestFile.disabled = testing || !(testFile.files.length || testedRun);
}

function setText(element, message) {
  if (element.textContent !== message) element.textContent = message;
}

function showStatus(id, message, error = false) {
  const element = byId(id);
  setText(element, message);
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
  if (submittedRun && submittedRun === job.run_id && !trainingActive) {
    submittedRun = null;
    if (job.status === "completed") {
      files.value = "";
      renderSelectedTrainingFiles();
    }
  }
  const savedFiles = job.saved_training_files ?? [];
  const missingFiles = job.missing_training_files ?? [];
  savedTrainingCount = savedFiles.length + missingFiles.length;
  const savedList = byId("uploaded-files");
  renderFileList(savedList, savedFiles);
  savedList.hidden = !savedFiles.length;
  byId("saved-files-empty").hidden = Boolean(savedTrainingCount || job.training_files_error);
  const savedError = job.training_files_error || (missingFiles.length
    ? "以下來源檔案缺失，將不納入訓練：" + missingFiles.join("、") : "");
  setText(byId("saved-files-error"), savedError);
  updateButtons();
  const progress = byId("train-progress");
  const progressWasHidden = progress.hidden;
  progress.hidden = !trainingActive || !job.total;
  if (!progress.hidden) {
    if (progress.max !== job.total) progress.max = job.total;
    if (progress.value !== job.completed) progress.value = job.completed;
    if (progressWasHidden) reveal(progress, { distance: 0 });
  }
  const stage = phases[job.phase];
  let message = job.message;
  if (stage) message = stage + " · " + message;
  if (!progress.hidden) message += "（" + job.completed + " / " + job.total + "）";
  if (job.status === "failed") message = "訓練失敗｜" + message;
  showStatus("train-status", message, job.status === "failed");
  const counts = job.status === "completed" ? null : job.counts;
  setText(byId("data-counts"), counts ? formatCounts(counts) : "");
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

function buildAxisChart(axis, counts, maximum) {
  const chart = document.createElement("figure");
  chart.className = "axis-chart";
  const caption = document.createElement("figcaption");
  caption.textContent = `${axis} 軸有效球分布`;
  chart.append(caption);

  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    const empty = document.createElement("p");
    empty.className = "report-meta";
    empty.textContent = "無有效球資料";
    chart.append(empty);
    return chart;
  }

  const rows = document.createElement("ul");
  rows.className = "axis-chart-rows";
  rows.setAttribute("role", "list");
  counts.forEach((count, index) => {
    const row = document.createElement("li");
    row.className = "axis-chart-row";
    const label = document.createElement("span");
    label.textContent = `第 ${index + 1} 格`;
    const track = document.createElement("span");
    track.className = "axis-chart-track";
    track.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.className = "axis-chart-bar";
    bar.style.inlineSize = `${(count / maximum) * 100}%`;
    track.append(bar);
    const value = document.createElement("span");
    value.className = "axis-chart-value";
    value.textContent = `${number.format(count)} 球（${((count / total) * 100).toFixed(1)}%）`;
    row.append(label, track, value);
    rows.append(row);
  });

  const scale = document.createElement("div");
  scale.className = "axis-chart-scale";
  scale.setAttribute("aria-hidden", "true");
  const ticks = document.createElement("div");
  ticks.className = "axis-chart-ticks";
  for (const tick of [0, maximum]) {
    const label = document.createElement("span");
    label.textContent = number.format(tick);
    ticks.append(label);
  }
  scale.append(ticks);
  chart.append(rows, scale);
  return chart;
}

function shadeHeatmapCell(cell, strength) {
  cell.style.setProperty("--heatmap-strength", strength);
  // The midpoint of the grayscale ramp is where black text becomes more legible.
  cell.classList.toggle("is-light-cell", strength >= 0.5);
}

function renderLandingHeatmap(grid) {
  const maximum = Math.max(0, ...grid.flat().map(({ balls }) => balls));
  const body = byId("landing-grid").tBodies[0];
  body.replaceChildren();

  for (const [index, values] of grid.entries()) {
    const row = body.insertRow();
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = index + 1;
    heading.setAttribute("aria-label", `Y 軸第 ${index + 1} 格`);
    row.append(heading);

    for (const { balls, groups } of values) {
      const cell = row.insertCell();
      shadeHeatmapCell(cell, maximum ? balls / maximum : 0);
      const ballCount = document.createElement("strong");
      ballCount.textContent = `${number.format(balls)} 球`;
      const groupCount = document.createElement("span");
      groupCount.textContent = `${number.format(groups)} 組設定`;
      cell.append(ballCount, groupCount);
    }
  }

  setText(byId("landing-heatmap-maximum"), `${number.format(maximum)} 球`);
  byId("landing-heatmap-scale").classList.toggle("is-empty", maximum === 0);
}

function renderDistribution(summary) {
  const { x_counts: xCounts, y_counts: yCounts } = summary;
  const maximum = Math.max(0, ...xCounts, ...yCounts);
  byId("axis-distribution").replaceChildren(
    buildAxisChart("X", xCounts, maximum),
    buildAxisChart("Y", yCounts, maximum),
  );
  renderLandingHeatmap(summary.grid);
  const totalCells = summary.grid.reduce((total, row) => total + row.length, 0);
  const unobserved = summary.unobserved_cells;
  const observed = totalCells - unobserved.length;
  setText(byId("observed-coverage"), `${number.format(observed)}／${number.format(totalCells)} 格`);
  setText(byId("observed-minimum"), observed ? `${number.format(summary.min_observed_balls)} 球` : "—");
  setText(byId("unobserved-cells"), unobserved.length
    ? "未觀測格 " + unobserved.map(([x, y]) => formatLanding(x, y)).join("、") : "");
  byId("coverage-warning").textContent = summary.sparse_cells.length
    ? "以下格子涵蓋少於五組四參數，無法覆蓋全部五折。 " + summary.sparse_cells
      .map(({ x, y, balls, groups }) => formatLanding(x, y) + " " +
        number.format(balls) + " 球／" + number.format(groups) + " 組").join("、")
    : "";
}

function buildPearsonChart(axis, parameters, values) {
  const chart = document.createElement("figure");
  chart.className = "pearson-chart";
  chart.setAttribute("aria-describedby", "pearson-legend");
  const caption = document.createElement("figcaption");
  caption.textContent = `與實測 ${axis} 的相關`;

  const rows = document.createElement("ul");
  rows.className = "pearson-chart-rows";
  rows.setAttribute("role", "list");
  for (const [index, parameter] of parameters.entries()) {
    const value = values[index];
    const row = document.createElement("li");
    row.className = "pearson-chart-row";
    const label = document.createElement("span");
    label.textContent = parameter;
    const track = document.createElement("span");
    track.className = "pearson-track";
    track.setAttribute("aria-hidden", "true");

    const coefficient = document.createElement("span");
    coefficient.className = "pearson-coefficient";
    coefficient.textContent = "—";
    if (value !== null) {
      const sign = value < 0 ? "−" : value > 0 ? "+" : "";
      coefficient.textContent = sign + Math.abs(value).toFixed(3);
      const bar = document.createElement("span");
      bar.className = "pearson-bar";
      bar.classList.toggle("is-negative", value < 0);
      bar.style.inlineSize = `${Math.min(Math.abs(value), 1) * 50}%`;
      track.append(bar);
    }
    row.append(label, track, coefficient);
    rows.append(row);
  }

  const scale = document.createElement("div");
  scale.className = "pearson-scale";
  scale.setAttribute("aria-hidden", "true");
  const ticks = document.createElement("div");
  ticks.className = "pearson-ticks";
  for (const value of ["−1", "0", "+1"]) {
    const tick = document.createElement("span");
    tick.textContent = value;
    ticks.append(tick);
  }
  scale.append(ticks);
  chart.append(caption, rows, scale);
  return chart;
}

function renderPearson({ labels, matrix }) {
  const parameters = labels.slice(0, -2);
  byId("pearson-charts").replaceChildren(
    buildPearsonChart("X", parameters, matrix[parameters.length]),
    buildPearsonChart("Y", parameters, matrix[parameters.length + 1]),
  );
  renderTable("pearson", "Pearson 相關係數（底色越亮，相關程度越強）", ["欄位", ...labels],
    matrix.map((row, index) => [labels[index], ...row]), (cell, value) => {
      cell.className = value === null ? "correlation correlation-missing" : "correlation";
      cell.textContent = value === null ? "無法計算" : value.toFixed(3);
      if (value !== null) shadeHeatmapCell(cell, Math.abs(value));
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

function renderValidationErrors(evaluation, baseline, hits) {
  const modelDistance = evaluation.mean_distance;
  const baselineDistance = baseline.mean_distance;
  // Round the scale up to a half-grid step and give two zero values a visible scale.
  const maximum = Math.max(0.5, Math.ceil(Math.max(modelDistance, baselineDistance) * 2) / 2);
  byId("validation-count").textContent = `依五折驗證的 ${number.format(evaluation.balls)} 顆有效球計算，每球同權`;
  const hitList = byId("validation-hits");
  hitList.hidden = !hits || evaluation.balls === 0;
  if (!hitList.hidden) {
    for (const [index, count] of [hits.same_cell, hits.within_one].entries()) {
      const row = hitList.children[index];
      row.querySelector("[data-count]").textContent = `${number.format(count)} / ${number.format(evaluation.balls)}`;
      row.querySelector("[data-rate]").textContent = `${(100 * count / evaluation.balls).toFixed(1)}%`;
    }
  }
  byId("validation-mean-distance").textContent = modelDistance.toFixed(2);
  byId("validation-x-mae").textContent = `${evaluation.x.mae.toFixed(2)} 格`;
  byId("validation-y-mae").textContent = `${evaluation.y.mae.toFixed(2)} 格`;
  byId("validation-error-midpoint").textContent = (maximum / 2).toFixed(2);
  byId("validation-error-maximum").textContent = `${maximum.toFixed(2)} 格`;

  for (const [id, distance] of [["validation-model-error", modelDistance], ["validation-baseline-error", baselineDistance]]) {
    const row = byId(id);
    row.querySelector(".validation-error-value").textContent = `${distance.toFixed(2)} 格`;
    row.querySelector(".axis-chart-bar").style.inlineSize = `${(distance / maximum) * 100}%`;
  }

  renderEvaluation("metrics", "迴歸模型與基準線", [
    ["兩軸勝出模型", evaluation], ["基準線", baseline],
  ]);
}

function renderFoldGuide(split) {
  const rows = foldLabels.map((validationFold, index) => {
    const row = document.createElement("li");
    const round = document.createElement("span");
    round.className = "fold-round";
    round.textContent = `第 ${index + 1} 輪`;
    row.append(round);
    for (const fold of foldLabels) {
      const cell = document.createElement("span");
      cell.className = "fold-cell";
      const isValidation = fold === validationFold;
      cell.classList.toggle("is-validation", isValidation);
      const letter = document.createElement("strong");
      letter.textContent = fold;
      const role = document.createElement("span");
      role.textContent = isValidation ? "驗證" : "訓練";
      cell.append(letter, role);
      row.append(cell);
    }
    return row;
  });
  byId("fold-rotation").replaceChildren(...rows);

  byId("split-method").textContent = "切分方法 " + split.method +
    (split.fallback_reason ? "。改用 GroupKFold 的原因為" + split.fallback_reason : "");
  byId("split-warning").textContent = split.warnings.length ? "分層切分警告／" + split.warnings.join("／") : "";
  renderTable("fold-summary", "各折資料量", ["折別", "訓練球數", "訓練組數", "驗證球數", "驗證組數"],
    Object.entries(split.folds).map(([fold, counts]) => [fold, ...[
      counts.training_balls, counts.training_groups, counts.validation_balls, counts.validation_groups,
    ].map(number.format)]),
  );
}

function renderModelSelection(report) {
  for (const card of byId("model-results").children) {
    const winner = report.winners[card.dataset.axis];
    let winnerName = winner ?? "—";
    for (const row of card.querySelectorAll("[data-model]")) {
      const model = row.dataset.model;
      const isWinner = model === winner;
      row.classList.toggle("is-winner", isWinner);
      row.querySelector("dd").textContent = report.selection[model]?.mean.toFixed(4) ?? "—";
      if (isWinner) winnerName = row.querySelector("dt").textContent;
    }
    card.querySelector(".model-result-winner").textContent = winnerName;
  }

  byId("selection-run").textContent = "訓練批次 " + report.run_id;
  const names = { baseline_x: "X 軸基準線（僅供比較）", baseline_y: "Y 軸基準線（僅供比較）" };
  renderTable("scores", "五折平均 MSE（格²，每折同權）", ["模型", ...foldLabels, "五折平均"],
    Object.entries(report.selection).map(([name, candidate]) => [
      names[name] ?? name, ...foldLabels.map((fold) => candidate.folds[fold].toFixed(4)),
      candidate.mean.toFixed(4),
    ]),
  );
}

function renderReport(report) {
  if (!displayedRun) showStatus("prediction-status", "等待輸入參數");
  displayedRun = report.run_id;
  updateButtons();
  byId("report-status").hidden = true;
  byId("report-note").textContent = report.note;
  for (const value of byId("report-counts").querySelectorAll("[data-count]")) {
    const count = report.data[value.dataset.count];
    setText(value, count == null ? "—" : number.format(count));
  }
  renderDistribution(report.data_summary);
  renderPearson(report.data_summary.pearson);
  renderFoldGuide(report.split);
  renderModelSelection(report);
  renderValidationErrors(report.evaluation, report.baseline_evaluation, report.validation_hits);
  const summary = byId("training-data-summary");
  const summaryWasHidden = summary.hidden;
  summary.hidden = false;
  if (summaryWasHidden) reveal(byId("training-data-summary-heading"));

  const content = byId("report");
  const firstAppearance = content.hidden;
  content.hidden = false;
  if (firstAppearance) reveal(byId("report-heading"));
}

function clearTestResult() {
  testedRun = null;
  byId("test-result").hidden = true;
  setText(byId("test-source"), "");
  setText(byId("test-count"), "");
  byId("test-metrics").replaceChildren();
}

function renderTestReport(result) {
  byId("test-source").textContent =
    "測試檔案 " + result.filename + "　正式模型批次 " + result.run_id;
  byId("test-count").textContent = formatCounts(result.counts) + "。以有效球計算誤差，每球同權。";
  renderEvaluation("test-metrics", "獨立測試誤差", [["正式模型", result.evaluation]]);
  testedRun = result.run_id;
  const report = byId("test-result");
  report.hidden = false;
  reveal(byId("test-result-heading"));
}

function observePublishedRun(runId) {
  latestRun = runId;
  if (testedRun && testedRun !== latestRun) {
    clearTestResult();
    showStatus("test-status", "正式模型已更新，請重新執行獨立測試。");
  }
}

function scheduleJobRefresh() {
  clearTimeout(pollTimer);
  if (document.hidden || clearingTraining || submitting) return;
  pollTimer = setTimeout(refreshJob, trainingActive ? 1500 : 8000);
}

async function refreshJob() {
  if (clearingTraining) return;
  if (polling !== null) return polling;
  clearTimeout(pollTimer);
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
      scheduleJobRefresh();
    }
  })();
  return polling;
}

function renderSelectedTrainingFiles() {
  renderFileList(byId("selected-files"), Array.from(files.files, (file) => file.name));
  const list = byId("selected-training");
  const wasHidden = list.hidden;
  list.hidden = !files.files.length;
  if (wasHidden && !list.hidden) reveal(list);
  const error = excelSelectionError(files);
  files.setCustomValidity(error);
  showStatus("train-file-error", files.files.length ? error : "", Boolean(error));
  updateButtons();
}

files.addEventListener("change", () => {
  submittedRun = null;
  renderSelectedTrainingFiles();
});

byId("training-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (files.disabled || excelSelectionError(files)) return;
  const body = new FormData(event.currentTarget);
  submitting = true;
  updateButtons();
  showStatus("train-file-error", "");
  showStatus("train-status", "正在上傳 Excel…");
  try {
    const job = await api("/api/training", { method: "POST", body });
    submittedRun = job.run_id;
    renderJob(job);
  } catch (error) {
    showStatus("train-file-error", error.message, true);
  } finally {
    submitting = false;
    updateButtons();
  }
  await refreshJob();
});

clearTraining.addEventListener("click", async () => {
  if (clearTraining.disabled || !window.confirm(
    "清除後，下次將只使用新上傳的檔案訓練。上一版訓練完成的模型仍可使用。",
  )) return;
  clearingTraining = true;
  updateButtons();
  try {
    await polling;
    const job = await api("/api/training/files", { method: "DELETE" });
    submittedRun = null;
    files.value = "";
    renderSelectedTrainingFiles();
    renderJob(job);
    showStatus("train-file-error", "已清除全部訓練資料。");
  } catch (error) {
    showStatus("train-file-error", error.message, true);
  } finally {
    clearingTraining = false;
    updateButtons();
    scheduleJobRefresh();
  }
});

function updateTestSelection(message = "") {
  clearTestResult();
  setText(byId("test-filename"), testFile.files[0]?.name ?? "");
  const error = testFile.files.length ? excelSelectionError(testFile, true) : "";
  showStatus("test-status", error || message, Boolean(error));
  updateButtons();
}

testFile.addEventListener("change", () => updateTestSelection());

clearTestFile.addEventListener("click", () => {
  if (clearTestFile.disabled) return;
  testFile.value = "";
  updateTestSelection("已清除測試資料與結果。");
  testFile.focus({ preventScroll: true });
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
  const wasHidden = measuredCoordinates.hidden;
  measuredCoordinates.hidden = !enabled;
  measuredCoordinates.disabled = !enabled;
  if (enabled && wasHidden) reveal(measuredCoordinates);
  renderComparison();
}

measuredStatus.addEventListener("change", updateMeasuredFields);
measuredCoordinates.addEventListener("input", renderComparison);

if (CSS.supports("appearance", "base-select") && CSS.supports("selector(::picker(select))")) {
  let pickerFrame = 0;

  function makeRoomForMeasuredPicker(event) {
    if (event.target !== measuredStatus || pickerFrame) return;
    pickerFrame = requestAnimationFrame(() => {
      pickerFrame = 0;
      if (!measuredStatus.matches(":open") || matchMedia("(forced-colors: active)").matches) return;

      const root = document.documentElement;
      const viewportHeight = root.clientHeight;
      const rem = parseFloat(getComputedStyle(root).fontSize);
      // Allow for the picker's capped height and the margins around it.
      const pickerHeight = Math.min(9.5 * rem, 0.58 * viewportHeight) + 0.75 * rem;
      const contentEdge = wideLayout.matches ? viewportHeight : bottomNavigation.getBoundingClientRect().top;
      const needed = Math.ceil(measuredStatus.getBoundingClientRect().bottom + pickerHeight - contentEdge);
      if (needed <= 0) return;

      const available = root.scrollHeight - viewportHeight - window.scrollY;
      if (needed > available) {
        const view = byId("prediction-view");
        const padding = parseFloat(view.style.paddingBlockEnd) || 0;
        view.style.paddingBlockEnd = `${padding + Math.ceil(needed - available)}px`;
      }
      window.scrollBy({ top: needed, behavior: reduceMotion.matches ? "instant" : "smooth" });
    });
  }

  measuredStatus.addEventListener("pointerdown", makeRoomForMeasuredPicker, { passive: true });
  measuredStatus.addEventListener("click", makeRoomForMeasuredPicker);
  measuredStatus.addEventListener("keydown", (event) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(event.key)) makeRoomForMeasuredPicker(event);
  });
}

function buildPredictionHeatmap() {
  // In Player A's view, X increases down the rows and Y increases across the columns.
  const grid = document.createDocumentFragment();
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
      grid.append(cell);
    }
  }
  predictionHeatmap.append(grid);
}

function renderPredictionHeatmap(prediction) {
  if (!prediction && predictionMarker.hidden) return;
  for (const { x, y, cell } of heatmapCells) {
    if (prediction) {
      const distance = Math.hypot(x - prediction.x, y - prediction.y);
      shadeHeatmapCell(cell, Math.max(0, 1 - distance / 2));
    } else {
      cell.style.removeProperty("--heatmap-strength");
      cell.classList.remove("is-light-cell");
    }
  }
  predictionMarker.hidden = !prediction;
  if (prediction) {
    predictionMarker.style.left = (prediction.y - 0.5) / 5 * 100 + "%";
    predictionMarker.style.top = (prediction.x - 0.5) / 5 * 100 + "%";
    reveal(predictionMarker, { distance: 0, scale: 0.78 });
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

buildPredictionHeatmap();
updateMeasuredFields();
updateButtons();
if (!document.hidden) refreshJob();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (!submitting) refreshJob();
    return;
  }
  clearTimeout(pollTimer);
});

const pageStart = byId("page-start");
const headerCollapseThreshold = byId("header-collapse-threshold");
const pageEnd = byId("page-end");
const pageEdges = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.target === pageStart) {
      siteHeader.classList.toggle("is-scrolled", !entry.isIntersecting);
      if (entry.isIntersecting) siteHeader.classList.remove("is-compact");
    } else if (entry.target === headerCollapseThreshold) {
      if (!entry.isIntersecting) siteHeader.classList.add("is-compact");
    } else {
      document.body.classList.toggle("can-scroll-down", !entry.isIntersecting);
    }
  }
});
pageEdges.observe(pageStart);
pageEdges.observe(headerCollapseThreshold);
pageEdges.observe(pageEnd);
